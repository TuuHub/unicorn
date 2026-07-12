import { spawnSync } from "node:child_process";

const baseUrl = process.argv[2] ?? process.env.MOODLE_BASE_URL ?? "https://learning.monash.edu";
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

const upload = spawnSync("npx", ["wrangler", "secret", "put", "MOODLE_SESSION"], {
  input: session.value,
  stdio: ["pipe", "inherit", "inherit"],
});
process.exit(upload.status ?? 1);
