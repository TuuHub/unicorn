// The hosted counterpart of the Worker's self-renewing Durable Object alarm (ADR-0021): one loop
// in the server process that runs each tenant's cycle (src/runtime/cycle.ts runCycle, unchanged)
// once an hour, a few tenants at a time so one slow Moodle doesn't hold up everyone else.

import { runCycle as defaultRunCycle, type CycleResult, type Env } from "../src/runtime/cycle";
import type { ControlStore } from "./control";
import type { TenantManager } from "./tenants";

export interface SchedulerOptions {
  control: ControlStore;
  tenants: TenantManager;
  intervalMs?: number; // how often to look for due tenants
  cycleMs?: number; // how often each tenant syncs
  concurrency?: number;
  runCycle?: (env: Env) => Promise<CycleResult>;
  log?: (event: Record<string, unknown>) => void;
  now?: () => Date;
}

export class HostedScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly running = new Set<string>();
  private ticking = false;

  constructor(private readonly options: SchedulerOptions) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.options.intervalMs ?? 60_000);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Runs every due tenant once; resolves when they are all done. Exposed for tests. */
  async tick(): Promise<number> {
    if (this.ticking) return 0;
    this.ticking = true;
    try {
      const now = (this.options.now ?? (() => new Date()))();
      const cycleMs = this.options.cycleMs ?? 60 * 60 * 1000;
      const due = this.options.control
        .list()
        .filter((account) => !this.running.has(account.id))
        .filter((account) => !account.lastCycleAt || now.getTime() - Date.parse(account.lastCycleAt) >= cycleMs);
      const queue = [...due];
      const workers = Array.from({ length: Math.min(this.options.concurrency ?? 3, queue.length) }, async () => {
        while (queue.length > 0) {
          const account = queue.shift()!;
          await this.runOne(account.id);
        }
      });
      await Promise.all(workers);
      this.options.control.pruneSessions();
      return due.length;
    } finally {
      this.ticking = false;
    }
  }

  private async runOne(id: string): Promise<void> {
    const log = this.options.log ?? ((event) => console.log(JSON.stringify(event)));
    const run = this.options.runCycle ?? ((env: Env) => defaultRunCycle(env, false));
    this.running.add(id);
    const started = Date.now();
    try {
      if (!this.options.control.get(id)) return; // deleted while queued
      const cycle = await run(this.options.tenants.env(id));
      // Counts only — never titles or content (same rule as the Worker's alarm log).
      log({
        event: "tenant_cycle_completed",
        tenant: id,
        ms: Date.now() - started,
        sources: cycle.sources.length,
        errors: cycle.sources.filter((source) => source.lastError).length,
      });
    } catch (error) {
      log({ event: "tenant_cycle_failed", tenant: id, message: error instanceof Error ? error.message : String(error) });
    } finally {
      // Marked even on failure, so a broken tenant retries next hour rather than every minute.
      if (this.options.control.get(id)) this.options.control.markCycle(id, new Date().toISOString());
      this.running.delete(id);
    }
  }
}
