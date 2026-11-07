#!/usr/bin/env node
// Bundles the hosted server (server/main.ts + the Worker code it reuses from src/) into one ESM
// file, dist/server.mjs, runnable with plain `node` (>= 22.19, for node:sqlite with FTS5).
// `cloudflare:workers` only exists inside workerd; the OAuth provider imports it for a feature we
// never use, so it is aliased to the same stub the test suite uses.

import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

await build({
  entryPoints: [path.join(root, "server/main.ts")],
  outfile: path.join(root, "dist/server.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  alias: { "cloudflare:workers": path.join(root, "server/stubs/cloudflare-workers.ts") },
  external: ["node:*"],
  banner: { js: "import { createRequire as __unicornCreateRequire } from 'node:module'; const require = __unicornCreateRequire(import.meta.url);" },
  logLevel: "info",
});
