import path from "node:path";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

// Tests run under plain Node, not workerd (no @cloudflare/vitest-pool-workers) — every existing
// test fakes D1/KV rather than needing the real runtime. @cloudflare/workers-oauth-provider
// (ADR-0035) imports the `cloudflare:workers` built-in at module load for its class-handler
// support, which only exists inside workerd; our handlers never use that path. A plain
// `resolve.alias` doesn't reach this specifier — Vite's SSR module runner recognizes the `:` as
// a protocol and hands it straight to Node's loader before alias resolution ever runs — so this
// resolves it in a `resolveId` hook instead. See tests/stubs/cloudflare-workers.ts.
function stubCloudflareWorkers(): Plugin {
  const stubPath = path.resolve(__dirname, "tests/stubs/cloudflare-workers.ts");
  return {
    name: "stub-cloudflare-workers",
    enforce: "pre",
    resolveId(id) {
      if (id === "cloudflare:workers") {
        return stubPath;
      }
    },
  };
}

export default defineConfig({
  plugins: [stubCloudflareWorkers()],
  test: {
    // Vitest externalizes node_modules for SSR by default (imported via Node's native loader,
    // bypassing Vite's plugin pipeline including the resolveId hook above) — inlining this one
    // package routes its `cloudflare:workers` import back through that pipeline instead.
    server: { deps: { inline: ["@cloudflare/workers-oauth-provider"] } },
  },
});
