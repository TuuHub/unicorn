export interface MemoryNote {
  domain: string;
  content: string;
  updatedAt: string;
}

// ADR-0024: judgment lives in a capped markdown document read in full on every
// reasoning call. The cap keeps density high enough that full-read stays correct.
export const MEMORY_TOKEN_CAP = 4_000;

// Rough token estimate without a tokenizer dependency: ~4 characters per token.
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export class MemoryCapExceededError extends Error {
  constructor(readonly tokens: number) {
    super(`Memory note is ${tokens} tokens, over the ${MEMORY_TOKEN_CAP} cap. Consolidate before saving.`);
    this.name = "MemoryCapExceededError";
  }
}

export interface MemoryStore {
  get(domain: string): Promise<MemoryNote>;
  list(): Promise<MemoryNote[]>;
  save(domain: string, content: string): Promise<MemoryNote>;
}

interface MemoryRow {
  domain: string;
  content: string;
  updated_at: string;
}

export class D1MemoryStore implements MemoryStore {
  constructor(
    private readonly db: D1Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async get(domain: string): Promise<MemoryNote> {
    const key = normalizeDomain(domain);
    const row = await this.db
      .prepare("SELECT domain, content, updated_at FROM agent_notes WHERE domain = ?")
      .bind(key)
      .first<MemoryRow>();
    if (!row) {
      return { domain: key, content: "", updatedAt: "1970-01-01T00:00:00.000Z" };
    }
    return { domain: row.domain, content: row.content, updatedAt: row.updated_at };
  }

  async list(): Promise<MemoryNote[]> {
    const rows = await this.db
      .prepare("SELECT domain, content, updated_at FROM agent_notes ORDER BY domain")
      .all<MemoryRow>();
    return rows.results.map((row) => ({ domain: row.domain, content: row.content, updatedAt: row.updated_at }));
  }

  async save(domain: string, content: string): Promise<MemoryNote> {
    const tokens = estimateTokens(content);
    if (tokens > MEMORY_TOKEN_CAP) {
      throw new MemoryCapExceededError(tokens);
    }
    const key = normalizeDomain(domain);
    const updatedAt = this.now().toISOString();
    await this.db
      .prepare(
        `INSERT INTO agent_notes (domain, content, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT (domain) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`,
      )
      .bind(key, content, updatedAt)
      .run();
    return { domain: key, content, updatedAt };
  }
}

function normalizeDomain(domain: string): string {
  const trimmed = domain.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(trimmed)) {
    throw new Error("Memory domain must be a short kebab-case slug.");
  }
  return trimmed;
}
