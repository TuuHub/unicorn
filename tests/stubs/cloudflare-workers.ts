// Stub for the `cloudflare:workers` built-in module, which only exists inside workerd. This
// repo's tests run under plain Node (no @cloudflare/vitest-pool-workers — see vitest.config.ts),
// but @cloudflare/workers-oauth-provider imports `WorkerEntrypoint` from it at module load time
// to support class-based handlers, a feature none of our handlers use. vitest.config.ts aliases
// `cloudflare:workers` to this file so the import resolves; nothing here needs to do anything.
export class WorkerEntrypoint<Env = unknown> {
  constructor(
    public ctx: unknown,
    public env: Env,
  ) {}
}
