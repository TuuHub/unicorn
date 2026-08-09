import type { Message } from "@earendil-works/pi-ai";
import type { JobRunInput } from "../jobs/daily-digest";
import type { AgentConversationStore, AgentTurnResult } from "./resident-agent";

interface MessageRow {
  message_json: string;
}

interface TurnResultRow {
  result_json: string;
}

export class D1AgentConversationStore implements AgentConversationStore {
  constructor(private readonly db: D1Database) {}

  async loadMessages(conversationId: string, limit = 40): Promise<Message[]> {
    const rows = await this.db
      .prepare(
        `SELECT message_json FROM (
           SELECT id, message_json
           FROM agent_messages
           WHERE conversation_id = ?
           ORDER BY id DESC
           LIMIT ?
         ) ORDER BY id ASC`,
      )
      .bind(conversationId, limit)
      .all<MessageRow>();
    return rows.results.map((row) => JSON.parse(row.message_json) as Message);
  }

  async getTurnResult(conversationId: string, idempotencyKey: string): Promise<AgentTurnResult | null> {
    const row = await this.db
      .prepare(
        `SELECT result_json
         FROM agent_turn_results
         WHERE conversation_id = ? AND idempotency_key = ?`,
      )
      .bind(conversationId, idempotencyKey)
      .first<TurnResultRow>();
    return row ? (JSON.parse(row.result_json) as AgentTurnResult) : null;
  }

  async commitTurn(input: {
    conversationId: string;
    messages: Message[];
    idempotencyKey?: string;
    result: AgentTurnResult;
    run: JobRunInput;
  }): Promise<void> {
    const now = input.run.createdAt;
    const statements: D1PreparedStatement[] = [
      this.db
        .prepare(
          `INSERT INTO agent_conversations (id, created_at, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET updated_at = excluded.updated_at`,
        )
        .bind(input.conversationId, now, now),
      ...input.messages.map((message) =>
        this.db
          .prepare(
            `INSERT INTO agent_messages (conversation_id, role, message_json, created_at)
             VALUES (?, ?, ?, ?)`,
          )
          .bind(input.conversationId, message.role, JSON.stringify(message), now),
      ),
      this.db
        .prepare(
          `INSERT INTO agent_job_runs (
             id, job_id, status, output, input_tokens, output_tokens, total_tokens, created_at
           ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          input.run.jobId,
          input.run.status,
          input.run.inputTokens,
          input.run.outputTokens,
          input.run.totalTokens,
          input.run.createdAt,
        ),
      this.db
        .prepare("UPDATE agent_jobs SET last_run_at = ?, updated_at = ? WHERE id = ?")
        .bind(input.run.createdAt, input.run.createdAt, input.run.jobId),
    ];
    if (input.idempotencyKey) {
      statements.push(
        this.db
          .prepare(
            `INSERT INTO agent_turn_results (conversation_id, idempotency_key, result_json, created_at)
             VALUES (?, ?, ?, ?)`,
          )
          .bind(input.conversationId, input.idempotencyKey, JSON.stringify(input.result), now),
      );
    }
    await this.db.batch(statements);
  }

  async reset(conversationId: string): Promise<void> {
    await this.db.batch([
      this.db.prepare("DELETE FROM agent_turn_results WHERE conversation_id = ?").bind(conversationId),
      this.db.prepare("DELETE FROM agent_messages WHERE conversation_id = ?").bind(conversationId),
      this.db.prepare("DELETE FROM agent_conversations WHERE id = ?").bind(conversationId),
    ]);
  }
}
