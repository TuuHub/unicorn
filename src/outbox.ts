import { configuredChannels, resolveNotifier, type NotifierChannel, type NotifierEnv } from "./notifier";

export interface OutboxMessage {
  idempotencyKey: string;
  channel: NotifierChannel;
  title: string;
  body: string;
}

interface OutboxRow {
  id: string;
  idempotency_key: string;
  channel: NotifierChannel;
  title: string;
  body: string;
  attempts: number;
  max_attempts: number;
}

export interface DeliveryResult {
  delivered: number;
  failed: number;
  retrying: number;
}

const BACKOFF_MINUTES = [1, 5, 15, 60, 240];

export class NotificationOutbox {
  constructor(
    private readonly db: D1Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  // Enqueue is idempotent on idempotency_key: a retried cycle that recomputes the
  // same message is a no-op, which is the whole point of the outbox (ADR-0025).
  async enqueue(message: OutboxMessage): Promise<void> {
    const nowIso = this.now().toISOString();
    await this.db
      .prepare(
        `INSERT INTO notifications_outbox (
           id, idempotency_key, channel, title, body, status, next_attempt_at, created_at
         ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
         ON CONFLICT (idempotency_key) DO NOTHING`,
      )
      .bind(crypto.randomUUID(), message.idempotencyKey, message.channel, message.title, message.body, nowIso, nowIso)
      .run();
  }

  // Deliver every message whose retry time has arrived. A failed send is rescheduled
  // with exponential backoff until max_attempts, then parked as 'failed'.
  async deliver(env: NotifierEnv, fetcher?: typeof fetch): Promise<DeliveryResult> {
    const nowIso = this.now().toISOString();
    const due = await this.db
      .prepare(
        `SELECT id, idempotency_key, channel, title, body, attempts, max_attempts
         FROM notifications_outbox
         WHERE status = 'pending' AND next_attempt_at <= ?
         ORDER BY next_attempt_at
         LIMIT 50`,
      )
      .bind(nowIso)
      .all<OutboxRow>();

    const result: DeliveryResult = { delivered: 0, failed: 0, retrying: 0 };
    for (const row of due.results) {
      const notifier = resolveNotifier(env, row.channel, fetcher);
      if (!notifier) {
        // The channel's secrets were removed after enqueue; park it rather than spin.
        await this.park(row.id, "channel_not_configured");
        result.failed += 1;
        continue;
      }
      try {
        await notifier.send({ title: row.title, body: row.body });
        await this.markDelivered(row.id);
        result.delivered += 1;
      } catch (error) {
        const attempts = row.attempts + 1;
        const message = error instanceof Error ? error.message : "send_failed";
        if (attempts >= row.max_attempts) {
          await this.park(row.id, message, attempts);
          result.failed += 1;
        } else {
          await this.reschedule(row.id, attempts, message);
          result.retrying += 1;
        }
      }
    }
    return result;
  }

  private markDelivered(id: string): Promise<unknown> {
    const nowIso = this.now().toISOString();
    return this.db
      .prepare(
        "UPDATE notifications_outbox SET status = 'delivered', attempts = attempts + 1, delivered_at = ?, last_error = NULL WHERE id = ?",
      )
      .bind(nowIso, id)
      .run();
  }

  private reschedule(id: string, attempts: number, error: string): Promise<unknown> {
    const minutes = BACKOFF_MINUTES[Math.min(attempts - 1, BACKOFF_MINUTES.length - 1)]!;
    const nextAttempt = new Date(this.now().getTime() + minutes * 60_000).toISOString();
    return this.db
      .prepare("UPDATE notifications_outbox SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?")
      .bind(attempts, nextAttempt, error, id)
      .run();
  }

  private park(id: string, error: string, attempts?: number): Promise<unknown> {
    const statement =
      attempts === undefined
        ? this.db
            .prepare("UPDATE notifications_outbox SET status = 'failed', last_error = ? WHERE id = ?")
            .bind(error, id)
        : this.db
            .prepare("UPDATE notifications_outbox SET status = 'failed', attempts = ?, last_error = ? WHERE id = ?")
            .bind(attempts, error, id);
    return statement.run();
  }
}

// Enqueue one message per configured channel, so every face receives it. The
// idempotency key must be stable for the same logical event across retried cycles.
export async function enqueueBroadcast(
  outbox: NotificationOutbox,
  env: NotifierEnv,
  key: string,
  title: string,
  body: string,
): Promise<void> {
  for (const channel of configuredChannels(env)) {
    await outbox.enqueue({ idempotencyKey: `${key}:${channel}`, channel, title, body });
  }
}
