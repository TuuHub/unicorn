// Entry point of the hosted, multi-tenant unicorn (ADR-0046). Built into dist/server.mjs by
// `npm run server:build` and run with `node dist/server.mjs` (see docs/HOSTED.md, Dockerfile).
//
// Configuration, all through the environment:
//   UNICORN_PUBLIC_URL   required  https://unicorn.example.com — what browsers and MCP clients use
//   UNICORN_SECRET       required  ≥32 random chars; derives every tenant's keys. Never rotate it
//                                  casually: stored source tokens become undecryptable (ADR-0039).
//   UNICORN_DATA_DIR     ./data    control.sqlite + tenants/<id>.sqlite
//   UNICORN_MIGRATIONS   ./migrations
//   PORT                 8787
//   UNICORN_OPERATOR     "the operator of this instance"  — shown on the landing page
//   UNICORN_SIGNUP       open | invite | closed   (default open)
//   UNICORN_SIGNUP_CODE  invite code when UNICORN_SIGNUP=invite
//   UNICORN_MAX_ACCOUNTS optional cap on sign-ups
//   UNICORN_TRUST_PROXY  1 when behind Caddy/nginx (use X-Forwarded-For for rate limiting)
//   MOODLE_BASE_URL, CANVAS_BASE_URL            defaults for every tenant
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET      enable "Connect Gmail" for every tenant

import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { configureChrome } from "../src/ui";
import { createHostedApp } from "./app";
import { ControlStore } from "./control";
import { clientIp, sendResponse, toRequest } from "./http";
import { HostedScheduler } from "./scheduler";
import { TenantManager } from "./tenants";

async function main(): Promise<void> {
  const env = process.env;
  const publicUrl = required("UNICORN_PUBLIC_URL").replace(/\/+$/, "");
  const secret = required("UNICORN_SECRET");
  if (secret.length < 32) fail("UNICORN_SECRET must be at least 32 characters (try: openssl rand -base64 48).");
  const dataDir = resolve(env.UNICORN_DATA_DIR ?? "./data");
  mkdirSync(dataDir, { recursive: true });

  // Quiet node:sqlite's "experimental" warning; everything else still prints.
  process.removeAllListeners("warning");
  process.on("warning", (warning) => {
    if (warning.name === "ExperimentalWarning" && /SQLite/.test(warning.message)) return;
    console.error(warning);
  });
  const { DatabaseSync } = await import("node:sqlite");

  const control = new ControlStore(new DatabaseSync(join(dataDir, "control.sqlite")), secret);
  const tenants = new TenantManager(
    DatabaseSync,
    control,
    {
      dataDir,
      migrationsDir: resolve(env.UNICORN_MIGRATIONS ?? "./migrations"),
      moodleBaseUrl: env.MOODLE_BASE_URL ?? "https://learning.monash.edu",
      canvasBaseUrl: env.CANVAS_BASE_URL,
      googleClientId: env.GOOGLE_CLIENT_ID,
      googleClientSecret: env.GOOGLE_CLIENT_SECRET,
    },
    control.kv(),
  );

  const signup = env.UNICORN_SIGNUP ?? "open";
  configureChrome({ extraNav: [{ path: "/account", label: "Account" }], brandHref: "/panel", instanceLabel: "Hosted" });
  const app = createHostedApp({
    control,
    tenants,
    config: {
      publicUrl,
      operator: env.UNICORN_OPERATOR ?? "the operator of this instance",
      repoUrl: env.UNICORN_REPO_URL ?? "https://github.com/TuuHub/unicorn",
      signupOpen: signup !== "closed",
      signupCode: signup === "invite" ? env.UNICORN_SIGNUP_CODE : undefined,
      maxAccounts: env.UNICORN_MAX_ACCOUNTS ? Number(env.UNICORN_MAX_ACCOUNTS) : undefined,
    },
  });
  const trustProxy = env.UNICORN_TRUST_PROXY === "1";

  const server = createServer((req, res) => {
    const request = toRequest(req, publicUrl);
    app
      .fetch(request, clientIp(req, trustProxy))
      .then((response) => sendResponse(res, response))
      .catch((error) => {
        console.error(JSON.stringify({ event: "unhandled", message: error instanceof Error ? error.message : String(error) }));
        if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
        res.end('{"error":"internal_error"}');
      });
  });

  const scheduler = new HostedScheduler({ control, tenants });
  const port = Number(env.PORT ?? 8787);
  server.listen(port, () => {
    console.log(JSON.stringify({ event: "listening", port, publicUrl, accounts: control.count(), signup }));
    scheduler.start();
  });

  const shutdown = () => {
    scheduler.stop();
    server.close(() => {
      tenants.closeAll();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) fail(`${name} is required. See docs/HOSTED.md.`);
  return value!;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

void main();
