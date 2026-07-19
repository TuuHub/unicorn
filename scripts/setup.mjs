import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

// ADR-0027: one linear installer, shared by humans and coding agents. Each step is a
// child process with inherited stdio, so Wrangler's own browser OAuth and prompts
// pass through untouched. Idempotent where it can be; loud where it can't.

function wrangler(args, options = {}) {
  return run("npx", ["wrangler", ...args], options);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", encoding: "utf8", ...options });
  if (result.status !== 0 && !options.allowFailure) {
    fail(`\`${command} ${args.join(" ")}\` exited with ${result.status ?? "a signal"}.`);
  }
  return result;
}

function capture(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    fail(result.stderr || `\`${command} ${args.join(" ")}\` failed.`);
  }
  return result.stdout;
}

function fail(message) {
  stdout.write(`\n✗ ${message}\n`);
  process.exit(1);
}

function step(message) {
  stdout.write(`\n▸ ${message}\n`);
}

function newToken() {
  return randomBytes(24).toString("base64url");
}

function putSecret(name, value) {
  const result = spawnSync("npx", ["wrangler", "secret", "put", name], {
    input: value,
    stdio: ["pipe", "inherit", "inherit"],
  });
  if (result.status !== 0) {
    fail(`Could not set secret ${name}.`);
  }
}

async function main() {
  const rl = createInterface({ input: stdin, output: stdout });

  step("Checking prerequisites");
  if (Number(process.versions.node.split(".")[0]) < 20) {
    fail(`Node 20+ is required; found ${process.versions.node}.`);
  }
  run("npm", ["install"]);

  step("Logging in to Cloudflare (a browser window may open)");
  wrangler(["login"]);

  step("Creating the D1 database");
  const createOutput = capture("npx", ["wrangler", "d1", "create", "unicorn"]);
  stdout.write(createOutput);
  const databaseId = extractDatabaseId(createOutput) ?? (await promptDatabaseId(rl));
  writeDatabaseId(databaseId);
  stdout.write(`  wrote database_id ${databaseId} into wrangler.jsonc\n`);

  step("Applying migrations");
  wrangler(["d1", "migrations", "apply", "unicorn", "--remote"]);

  step("Generating and storing operator secrets");
  const adminToken = newToken();
  putSecret("ADMIN_TOKEN", adminToken);
  putSecret("MCP_TOKEN", newToken());

  if (await confirm(rl, "Set an Ed Discussion API token now?")) {
    const value = (await rl.question("Paste the Ed API token: ")).trim();
    if (value) {
      putSecret("ED_API_TOKEN", value);
    }
  }

  if (await confirm(rl, "Push a Moodle session from your local Okta login?")) {
    run("npm", ["run", "moodle:push"], { allowFailure: true });
  }

  step("Deploying the Worker");
  wrangler(["deploy"]);

  const workerUrl = (await rl.question("\nWorker URL (e.g. https://unicorn.<subdomain>.workers.dev): ")).trim();
  rl.close();

  if (workerUrl) {
    step("Starting the hourly scheduler");
    run("curl", [
      "-fsS",
      "-X",
      "POST",
      `${workerUrl.replace(/\/$/, "")}/schedule`,
      "-H",
      `Authorization: Bearer ${adminToken}`,
    ], { allowFailure: true });
  }

  stdout.write(
    `\n✓ Setup complete.\n  Settings page: HTTP Basic user "unicorn", password is your ADMIN_TOKEN.\n  MCP client: connect to <worker>/mcp with the MCP_TOKEN.\n  Both tokens were generated randomly; retrieve them from the Cloudflare dashboard if needed.\n`,
  );
}

function confirm(rl, question) {
  return rl.question(`${question} [y/N] `).then((answer) => answer.trim().toLowerCase() === "y");
}

function extractDatabaseId(output) {
  const match =
    /database_id\s*=\s*"([0-9a-f-]{36})"/i.exec(output) ?? /"database_id"\s*:\s*"([0-9a-f-]{36})"/i.exec(output);
  return match?.[1] ?? null;
}

async function promptDatabaseId(rl) {
  stdout.write("\nCould not parse the database_id automatically from the output above.\n");
  const value = (await rl.question("Paste the database_id: ")).trim();
  if (!/^[0-9a-f-]{36}$/i.test(value)) {
    fail("That does not look like a database_id.");
  }
  return value;
}

// Replace the database_id in wrangler.jsonc without a JSONC parser dependency: the
// field is a single quoted UUID, so a scoped regex is safe and keeps comments intact.
function writeDatabaseId(databaseId) {
  const path = "wrangler.jsonc";
  const source = readFileSync(path, "utf8");
  if (!/"database_id"\s*:\s*"[^"]*"/.test(source)) {
    fail(`Could not find a database_id field in ${path} to update.`);
  }
  writeFileSync(path, source.replace(/("database_id"\s*:\s*")[^"]*(")/, `$1${databaseId}$2`));
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
