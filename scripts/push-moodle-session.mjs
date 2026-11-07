import { spawnSync } from "node:child_process";

// Pushes a fresh MoodleSession cookie, read from a local Okta login (`okta login <moodle url>`).
//
//   npm run moodle:push [-- <moodle base url>]
//       Self-deployed Worker: stores it as the MOODLE_SESSION Worker Secret via wrangler.
//
//   npm run moodle:push -- --hosted https://unicorn.example.com --token uni_… [<moodle base url>]
//       Hosted unicorn (ADR-0046): posts it to your account, encrypted at rest. The token is the
//       personal access token shown on the dashboard's Connect page (or UNICORN_TOKEN).

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  args.splice(index, 2);
  return value;
};
const hosted = option("--hosted") ?? process.env.UNICORN_HOSTED_URL;
const token = option("--token") ?? process.env.UNICORN_TOKEN;
const baseUrl = args[0] ?? process.env.MOODLE_BASE_URL ?? "https://learning.monash.edu";

const cookies = spawnSync("okta", ["cookies", baseUrl, "--json"], { encoding: "utf8" });
if (cookies.status !== 0) {
  process.stderr.write(cookies.stderr || "Could not read the saved Okta session.\n");
  process.exit(cookies.status ?? 1);
}

const payload = JSON.parse(cookies.stdout);
const session = payload.cookies?.find(
  (cookie) => cookie.name === "MoodleSession" && new URL(baseUrl).hostname.endsWith(cookie.domain.replace(/^\./, "")),
);
if (!session?.value) {
  process.stderr.write(`No MoodleSession cookie found for ${baseUrl}. Run \`okta login ${baseUrl}\` first.\n`);
  process.exit(1);
}

if (hosted) {
  if (!token) {
    process.stderr.write("--hosted needs --token (your personal access token from the Connect page) or UNICORN_TOKEN.\n");
    process.exit(1);
  }
  const response = await fetch(new URL("/api/sources/moodle/session", hosted), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ session: session.value, baseUrl }),
  });
  if (!response.ok) {
    process.stderr.write(`unicorn rejected the session (${response.status}): ${await response.text()}\n`);
    process.exit(1);
  }
  process.stdout.write(`Moodle session saved to ${new URL(hosted).host}. It syncs within the hour, or press Sync now under Sources.\n`);
  process.exit(0);
}

const upload = spawnSync("npx", ["wrangler", "secret", "put", "MOODLE_SESSION"], {
  input: session.value,
  stdio: ["pipe", "inherit", "inherit"],
});
process.exit(upload.status ?? 1);
