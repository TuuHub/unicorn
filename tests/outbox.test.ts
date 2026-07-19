import { describe, expect, it, vi } from "vitest";
import { NotificationOutbox } from "../src/outbox";

interface Stored {
  id: string;
  idempotency_key: string;
  channel: string;
  title: string;
  body: string;
  status: string;
  attempts: number;
  max_attempts: number;
  next_attempt_at: string;
  last_error: string | null;
  delivered_at: string | null;
}

// A tiny in-memory D1 double covering exactly the statements the outbox issues.
function fakeDb(rows: Stored[]) {
  return {
    prepare(sql: string) {
      const binder = {
        args: [] as unknown[],
        bind(...args: unknown[]) {
          this.args = args;
          return this;
        },
        async run() {
          if (sql.startsWith("INSERT INTO notifications_outbox")) {
            const [id, key, channel, title, body, nextAttempt, createdAt] = this.args as string[];
            if (rows.some((row) => row.idempotency_key === key)) {
              return { meta: { changes: 0 } };
            }
            rows.push({
              id,
              idempotency_key: key,
              channel,
              title,
              body,
              status: "pending",
              attempts: 0,
              max_attempts: 5,
              next_attempt_at: nextAttempt,
              last_error: null,
              delivered_at: null,
            });
            void createdAt;
            return { meta: { changes: 1 } };
          }
          if (sql.includes("status = 'delivered'")) {
            const [, id] = this.args as string[];
            update(rows, id, { status: "delivered", last_error: null });
            return { meta: { changes: 1 } };
          }
          if (sql.includes("SET status = 'failed', attempts = ?")) {
            const [attempts, error, id] = this.args as [number, string, string];
            update(rows, id, { status: "failed", attempts, last_error: error });
            return { meta: { changes: 1 } };
          }
          if (sql.includes("SET status = 'failed'")) {
            const [error, id] = this.args as [string, string];
            update(rows, id, { status: "failed", last_error: error });
            return { meta: { changes: 1 } };
          }
          if (sql.startsWith("UPDATE notifications_outbox SET attempts = ?, next_attempt_at")) {
            const [attempts, nextAttempt, error, id] = this.args as [number, string, string, string];
            update(rows, id, { attempts, next_attempt_at: nextAttempt, last_error: error });
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        },
        async all<T>() {
          const [nowIso] = this.args as string[];
          return {
            results: rows
              .filter((row) => row.status === "pending" && row.next_attempt_at <= nowIso)
              .slice(0, 50) as unknown as T[],
          };
        },
      };
      return binder;
    },
  } as unknown as D1Database;
}

function update(rows: Stored[], id: string, patch: Partial<Stored>) {
  const row = rows.find((candidate) => candidate.id === id);
  if (row) {
    Object.assign(row, patch);
  }
}

describe("NotificationOutbox", () => {
  it("enqueues each key once even across retried cycles", async () => {
    const rows: Stored[] = [];
    const outbox = new NotificationOutbox(fakeDb(rows), () => new Date("2026-07-19T00:00:00.000Z"));

    await outbox.enqueue({ idempotencyKey: "sync:abc:discord", channel: "discord", title: "t", body: "b" });
    await outbox.enqueue({ idempotencyKey: "sync:abc:discord", channel: "discord", title: "t", body: "b" });

    expect(rows).toHaveLength(1);
  });

  it("marks a message delivered when the channel accepts it", async () => {
    const rows: Stored[] = [];
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const outbox = new NotificationOutbox(fakeDb(rows), () => new Date("2026-07-19T00:00:00.000Z"));
    await outbox.enqueue({ idempotencyKey: "k:discord", channel: "discord", title: "t", body: "b" });

    const result = await outbox.deliver({ NOTIFIER_URL: "https://discord.example/webhook" }, fetcher as typeof fetch);

    expect(result).toEqual({ delivered: 1, failed: 0, retrying: 0 });
    expect(rows[0]?.status).toBe("delivered");
  });

  it("reschedules with backoff on a failed send instead of dropping it", async () => {
    const rows: Stored[] = [];
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 500 }));
    const outbox = new NotificationOutbox(fakeDb(rows), () => new Date("2026-07-19T00:00:00.000Z"));
    await outbox.enqueue({ idempotencyKey: "k:discord", channel: "discord", title: "t", body: "b" });

    const result = await outbox.deliver({ NOTIFIER_URL: "https://discord.example/webhook" }, fetcher as typeof fetch);

    expect(result).toEqual({ delivered: 0, failed: 0, retrying: 1 });
    expect(rows[0]?.status).toBe("pending");
    expect(rows[0]?.attempts).toBe(1);
    expect(rows[0]?.next_attempt_at).toBe("2026-07-19T00:01:00.000Z");
  });

  it("parks a message as failed after the last attempt", async () => {
    const rows: Stored[] = [];
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 500 }));
    const outbox = new NotificationOutbox(fakeDb(rows), () => new Date("2026-07-19T00:00:00.000Z"));
    await outbox.enqueue({ idempotencyKey: "k:discord", channel: "discord", title: "t", body: "b" });
    rows[0]!.attempts = 4;

    const result = await outbox.deliver({ NOTIFIER_URL: "https://discord.example/webhook" }, fetcher as typeof fetch);

    expect(result).toEqual({ delivered: 0, failed: 1, retrying: 0 });
    expect(rows[0]?.status).toBe("failed");
  });
});
