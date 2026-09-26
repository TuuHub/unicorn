import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { env as processEnv, stdin, stdout } from "node:process";

// ADR-0027: one linear installer, shared by humans and coding agents. Each step is a
// child process with inherited stdio, so Wrangler's own browser OAuth and prompts
// pass through untouched. Idempotent where it can be; loud where it can't.

// ADR-0038 sources this installer onboards. Ed/Moodle/Canvas ask for a credential at
// the terminal (or take it from an env var, for a non-interactive agent run) and
// `wrangler secret put` it; Gmail is Google OAuth, finished from /settings after deploy.
export const KNOWN_SOURCES = ["ed", "moodle", "canvas", "gmail"];

// Pure: comma/whitespace-separated source list -> a deduped, validated array, in
// KNOWN_SOURCES order. Throws with every invalid entry named at once, not just the
// first, since an agent composing this from a user's message benefits more from the
// full picture than from fixing one typo at a time.
export function parseSourceList(raw) {
  const requested = [...new Set(raw.split(/[,\s]+/).map((entry) => entry.trim().toLowerCase()).filter(Boolean))];
  const invalid = requested.filter((source) => !KNOWN_SOURCES.includes(source));
  if (invalid.length > 0) {
    throw new Error(`Unknown source(s): ${invalid.join(", ")}. Known sources: ${KNOWN_SOURCES.join(", ")}.`);
  }
  return KNOWN_SOURCES.filter((source) => requested.includes(source));
}

function truthy(value) {
  return value !== undefined && /^(1|true|yes|y)$/i.test(value.trim());
}

// Pure: argv (e.g. process.argv.slice(2)) + an env map -> the installer's options. A
// flag always wins over its env-var fallback, so a script invocation can override an
// agent's ambient environment. Unrecognized flags are ignored rather than rejected —
// this installer is meant to tolerate being invoked alongside other tools' flags.
export function parseArgs(argv, env = {}) {
  const options = {
    sources: null,
    yes: truthy(env.SETUP_YES),
    workerUrl: env.SETUP_WORKER_URL?.trim() || null,
    timezone: env.SETUP_TIMEZONE?.trim() || null,
  };
  if (env.SETUP_SOURCES?.trim()) {
    options.sources = parseSourceList(env.SETUP_SOURCES);
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const [flag, inlineValue] = arg.startsWith("--") ? splitFlag(arg) : [null, null];
    const takeValue = () => inlineValue ?? argv[++index];

    if (flag === "sources") {
      options.sources = parseSourceList(takeValue() ?? "");
    } else if (flag === "yes" || arg === "-y") {
      options.yes = true;
    } else if (flag === "worker-url") {
      options.workerUrl = takeValue()?.trim() || null;
    } else if (flag === "timezone") {
      options.timezone = takeValue()?.trim() || null;
    }
  }
  return options;
}

function splitFlag(arg) {
  const withoutDashes = arg.slice(2);
  const equals = withoutDashes.indexOf("=");
  return equals === -1 ? [withoutDashes, null] : [withoutDashes.slice(0, equals), withoutDashes.slice(equals + 1)];
}

// Pure: the IANA zone to default to, honoring an explicit override first.
export function resolveTimezone(explicit) {
  if (explicit) {
    return explicit;
  }
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
}

// One secret (or a small ordered group of them, like Canvas's base URL + token) a
// source needs. `envVar` doubles as both the non-interactive source and the
// `wrangler secret put` name — every one of these is already a live PLUGIN_SECRET_*/
// operator-secret name env-precedence in src/sources.ts checks first.
const SOURCE_SECRETS = {
  ed: [{ envVar: "ED_API_TOKEN", prompt: "Paste the Ed API token" }],
  canvas: [
    { envVar: "CANVAS_BASE_URL", prompt: "Canvas base URL (e.g. https://school.instructure.com)" },
    { envVar: "PLUGIN_SECRET_CANVAS_TOKEN", prompt: "Paste the Canvas personal access token" },
  ],
  gmail: [
    { envVar: "PLUGIN_SECRET_GOOGLE_CLIENT_ID", prompt: "Paste the Google OAuth client id" },
    { envVar: "PLUGIN_SECRET_GOOGLE_CLIENT_SECRET", prompt: "Paste the Google OAuth client secret" },
  ],
  // moodle is handled separately below (npm run moodle:push), not a pasted secret.
};

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

// Returns { stdout, stderr, ok } instead of failing — for steps
// that have a meaningful "already exists" path.
function tryCapture(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", ok: result.status === 0 };
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

// Escapes a single-quoted SQL string literal. Every value passed through here is
// either a validated IANA timezone name or something we generated — never untrusted
// input — but the escape is cheap and correct regardless.
function sqlLiteral(value) {
  return `'${value.replace(/'/g, "''")}'`;
}

async function selectSources(rl, options) {
  if (options.sources) {
    return options.sources;
  }
  if (options.yes) {
    // Non-interactive with no explicit list: configure nothing here and say so —
    // every source can still be added later from /settings, per-source, with no
    // redeploy (ADR-0038's whole point).
    return [];
  }
  step("Which sources do you use? (leave blank to skip, and add it later from /settings)");
  const selected = [];
  for (const source of KNOWN_SOURCES) {
    if (await confirm(rl, `  ${label(source)}?`)) {
      selected.push(source);
    }
  }
  return selected;
}

function label(source) {
  return { ed: "Ed Discussion", moodle: "Moodle", canvas: "Canvas", gmail: "Gmail" }[source];
}

// Configures one non-Moodle source: for each secret it needs, prefer an env var
// already set (the non-interactive/agent path) and fall back to an interactive
// prompt; with neither, just tell the operator where to paste it later.
async function configureSource(rl, source, options) {
  const secrets = SOURCE_SECRETS[source];
  if (!secrets) {
    return;
  }
  step(`Configuring ${label(source)}`);
  const values = {};
  for (const { envVar, prompt } of secrets) {
    const fromEnv = processEnv[envVar]?.trim();
    if (fromEnv) {
      values[envVar] = fromEnv;
      continue;
    }
    if (options.yes) {
      stdout.write(`  ${envVar} not set — skipping; paste it into /settings after deploy instead.\n`);
      return;
    }
    values[envVar] = (await rl.question(`  ${prompt}: `)).trim();
  }
  if (Object.values(values).every((value) => value)) {
    for (const [envVar, value] of Object.entries(values)) {
      putSecret(envVar, value);
    }
  } else {
    stdout.write("  Skipped — you can paste this into /settings after deploy instead.\n");
  }
}

async function configureMoodle(rl, options) {
  step("Configuring Moodle");
  if (options.yes) {
    stdout.write("  Run `npm run moodle:push` yourself once deployed (it opens a browser Okta login).\n");
    return;
  }
  if (await confirm(rl, "  Push a Moodle session from your local Okta login now?")) {
    run("npm", ["run", "moodle:push"], { allowFailure: true });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2), processEnv);
  const rl = createInterface({ input: stdin, output: stdout });

  step("Checking prerequisites");
  const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
  if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 19)) {
    fail(`Node 22.19+ is required by the Pi runtime; found ${process.versions.node}.`);
  }
  run("npm", ["install"]);

  step("Logging in to Cloudflare (a browser window may open)");
  wrangler(["login"]);

  step("Creating the D1 database");
  // Idempotent: if the DB already exists this is an upgrade, so reuse it rather than
  // aborting. `d1 create` fails on a name clash; fall back to reading the existing id.
  const created = tryCapture("npx", ["wrangler", "d1", "create", "unicorn"]);
  stdout.write(created.ok ? created.stdout : created.stderr);
  let databaseId = extractDatabaseId(created.stdout);
  if (!databaseId) {
    const existing = tryCapture("npx", ["wrangler", "d1", "info", "unicorn", "--json"]);
    databaseId = extractDatabaseId(existing.stdout) ?? readDatabaseId() ?? (await promptDatabaseId(rl));
    if (!created.ok) {
      stdout.write("  database already exists — reusing it (upgrade path)\n");
    }
  }
  writeDatabaseId(databaseId);
  stdout.write(`  wrote database_id ${databaseId} into wrangler.jsonc\n`);

  step("Applying migrations");
  wrangler(["d1", "migrations", "apply", "unicorn", "--remote"]);

  const timezone = resolveTimezone(options.timezone);
  step(`Setting your default timezone (${timezone})`);
  // json_set merges into whatever's already in the 'app' settings row (or creates it)
  // without clobbering retentionDays/gmailDomains/etc. that a re-run might already have.
  wrangler([
    "d1",
    "execute",
    "unicorn",
    "--remote",
    "--command",
    `INSERT INTO settings (key, value_json, updated_at) VALUES ('app', json_object('timezone', ${sqlLiteral(timezone)}), datetime('now')) ON CONFLICT(key) DO UPDATE SET value_json = json_set(value_json, '$.timezone', ${sqlLiteral(timezone)}), updated_at = excluded.updated_at`,
  ]);

  step("Generating and storing operator secrets");
  const adminToken = newToken();
  const mcpToken = newToken();
  putSecret("ADMIN_TOKEN", adminToken);
  putSecret("MCP_TOKEN", mcpToken);

  const sources = await selectSources(rl, options);
  for (const source of sources) {
    if (source === "moodle") {
      await configureMoodle(rl, options);
    } else {
      await configureSource(rl, source, options);
    }
  }
  if (sources.length === 0) {
    stdout.write("\n  No sources configured now — add any of them later from /settings, no redeploy needed.\n");
  }

  step("Deploying the Worker");
  wrangler(["deploy"]);

  const workerUrl = (options.workerUrl ?? (options.yes ? "" : await rl.question("\nWorker URL (e.g. https://unicorn.<subdomain>.workers.dev): "))).trim();
  rl.close();

  if (workerUrl) {
    step("Starting the hourly scheduler");
    // Pass the token via a header file on stdin, not argv: process arguments are
    // world-readable (`ps aux`, /proc/<pid>/cmdline), so a co-tenant could read the
    // live ADMIN_TOKEN off the curl command line otherwise.
    const started = run(
      "curl",
      ["-fsS", "-X", "POST", `${workerUrl.replace(/\/$/, "")}/schedule`, "-H", "@-"],
      { allowFailure: true, input: `Authorization: Bearer ${adminToken}`, stdio: ["pipe", "inherit", "inherit"] },
    );
    if (started.status !== 0) {
      stdout.write(
        `\n  Could not reach ${workerUrl}/schedule automatically. Start it yourself with:\n` +
          `  curl -X POST ${workerUrl.replace(/\/$/, "")}/schedule -H "Authorization: Bearer <ADMIN_TOKEN>"\n`,
      );
    }
  }

  stdout.write(`\n✓ Setup complete.\n  Settings page: HTTP Basic user "unicorn", password is your ADMIN_TOKEN.\n`);
  if (workerUrl) {
    const doorUrl = `${workerUrl.replace(/\/$/, "")}/mcp`;
    stdout.write(
      `\n  Connect your agent:\n` +
        `    claude mcp add --transport http unicorn ${doorUrl} --header "Authorization: Bearer ${mcpToken}"\n` +
        `  Or add unicorn as a claude.ai / ChatGPT connector at:\n` +
        `    ${doorUrl}\n` +
        `\n  Claude Code plugin (playbooks, /mcp/admin operator tools):\n` +
        `    claude plugin marketplace add TuuHub/unicorn\n` +
        `    claude plugin install unicorn@unicorn\n`,
    );
  }
  stdout.write(`\n  Both tokens were generated randomly; retrieve them from the Cloudflare dashboard if needed.\n`);
}

function confirm(rl, question) {
  return rl.question(`${question} [y/N] `).then((answer) => answer.trim().toLowerCase() === "y");
}

function extractDatabaseId(output) {
  const match =
    /database_id\s*=\s*"([0-9a-f-]{36})"/i.exec(output) ?? /"database_id"\s*:\s*"([0-9a-f-]{36})"/i.exec(output);
  return match?.[1] ?? null;
}

// Read the id already committed to wrangler.jsonc, if any (the upgrade case where the
// repo was cloned with a live database_id).
function readDatabaseId() {
  try {
    return extractDatabaseId(readFileSync("wrangler.jsonc", "utf8"));
  } catch {
    return null;
  }
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

// Only run the installer when this file is executed directly (`npm run setup`), not
// when a test imports it for the pure functions above.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
}
