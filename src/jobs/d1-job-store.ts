import type { AgentJob, AgentJobConfig, JobRunInput, JobStore } from "./daily-digest";

interface JobRow {
  id: string;
  enabled: number;
  model: string;
  monthly_token_cap: number;
  schedule_hour_utc: number;
  credential_preference: "byok";
  current_month_usage: number;
  last_run_at: string | null;
}

interface RunRow {
  id: string;
  job_id: string;
  status: string;
  output: string | null;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  created_at: string;
}

export interface AgentJobRun {
  id: string;
  jobId: string;
  status: string;
  output?: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  createdAt: string;
}

export class D1JobStore implements JobStore {
  constructor(private readonly db: D1Database) {}

  async get(id: string): Promise<AgentJob | null> {
    const now = new Date();
    const row = await this.db
      .prepare(`${jobSelect()} WHERE j.id = ? GROUP BY j.id`)
      .bind(now.toISOString().slice(0, 7), id)
      .first<JobRow>();
    return row ? parseJob(row, now) : null;
  }

  async list(): Promise<AgentJob[]> {
    const now = new Date();
    const rows = await this.db
      .prepare(`${jobSelect()} GROUP BY j.id ORDER BY j.id`)
      .bind(now.toISOString().slice(0, 7))
      .all<JobRow>();
    return rows.results.map((row) => parseJob(row, now));
  }

  async configure(
    id: string,
    input: AgentJobConfig,
  ): Promise<AgentJob> {
    const result = await this.db
      .prepare(
        `UPDATE agent_jobs
         SET enabled = ?, model = ?, monthly_token_cap = ?, schedule_hour_utc = ?,
             credential_preference = ?, updated_at = ?
         WHERE id = ?`,
      )
      .bind(
        input.enabled ? 1 : 0,
        input.model,
        input.monthlyTokenCap,
        input.scheduleHourUtc,
        input.credentialPreference,
        new Date().toISOString(),
        id,
      )
      .run();
    if (result.meta.changes !== 1) {
      throw new Error(`Unknown agent job ${id}.`);
    }
    return (await this.get(id))!;
  }

  async getMonthlyUsage(id: string, month: string): Promise<number> {
    const row = await this.db
      .prepare(
        `SELECT COALESCE(SUM(total_tokens), 0) AS total
         FROM agent_job_runs
         WHERE job_id = ? AND substr(created_at, 1, 7) = ?`,
      )
      .bind(id, month)
      .first<{ total: number }>();
    return row?.total ?? 0;
  }

  async recordRun(run: JobRunInput): Promise<void> {
    const id = crypto.randomUUID();
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO agent_job_runs (
             id, job_id, status, output, input_tokens, output_tokens, total_tokens, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          id,
          run.jobId,
          run.status,
          run.output ?? null,
          run.inputTokens,
          run.outputTokens,
          run.totalTokens,
          run.createdAt,
        ),
      this.db
        .prepare("UPDATE agent_jobs SET last_run_at = ?, updated_at = ? WHERE id = ?")
        .bind(run.watermark ?? run.createdAt, run.createdAt, run.jobId),
    ]);
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    await this.db
      .prepare("UPDATE agent_jobs SET enabled = ?, updated_at = ? WHERE id = ?")
      .bind(enabled ? 1 : 0, new Date().toISOString(), id)
      .run();
  }

  async listRuns(id: string, limit: number): Promise<AgentJobRun[]> {
    const rows = await this.db
      .prepare("SELECT * FROM agent_job_runs WHERE job_id = ? ORDER BY created_at DESC LIMIT ?")
      .bind(id, limit)
      .all<RunRow>();
    return rows.results.map((row) => ({
      id: row.id,
      jobId: row.job_id,
      status: row.status,
      ...(row.output ? { output: row.output } : {}),
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      totalTokens: row.total_tokens,
      createdAt: row.created_at,
    }));
  }
}

function jobSelect(): string {
  return `SELECT j.*,
           COALESCE(SUM(CASE WHEN substr(r.created_at, 1, 7) = ? THEN r.total_tokens ELSE 0 END), 0)
             AS current_month_usage
          FROM agent_jobs j
          LEFT JOIN agent_job_runs r ON r.job_id = j.id`;
}

function parseJob(row: JobRow, now: Date): AgentJob {
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  const projectedMonthlyTokens = Math.ceil((row.current_month_usage / now.getUTCDate()) * daysInMonth);
  return {
    id: row.id,
    enabled: row.enabled === 1,
    model: row.model,
    monthlyTokenCap: row.monthly_token_cap,
    scheduleHourUtc: row.schedule_hour_utc,
    credentialPreference: row.credential_preference,
    currentMonthUsage: row.current_month_usage,
    projectedMonthlyTokens,
    lastRunAt: row.last_run_at,
  };
}
