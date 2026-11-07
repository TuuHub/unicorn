// The hosted server's control plane (ADR-0046): accounts, browser sessions, and the KV store the
// OAuth provider keeps its clients, grants and tokens in. One SQLite file for the whole server,
// separate from every tenant's own database — a tenant's data never shares a file with another's.

import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface Account {
  id: string; // the tenant id; also the OAuth grant user id
  email: string;
  createdAt: string;
  tokenVersion: number;
  lastCycleAt: string | null;
}

interface AccountRow {
  id: string;
  email: string;
  password_hash: string;
  created_at: string;
  token_version: number;
  last_cycle_at: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  token_version INTEGER NOT NULL DEFAULT 1,
  last_cycle_at TEXT,
  last_login_at TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_account ON sessions (account_id);
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  expires_at INTEGER
);
`;

const SESSION_DAYS = 30;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export class ControlStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly secret: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    db.exec(SCHEMA);
  }

  // --- accounts ---------------------------------------------------------------

  createAccount(email: string, password: string): Account {
    const normalized = normalizeEmail(email);
    if (!normalized) {
      throw new AccountError("invalid_email", "Enter a valid email address.");
    }
    if (password.length < 10) {
      throw new AccountError("weak_password", "Use a password of at least 10 characters.");
    }
    if (this.findByEmail(normalized)) {
      throw new AccountError("email_taken", "An account with that email already exists. Sign in instead.");
    }
    const id = `t${randomBytes(10).toString("hex")}`;
    const createdAt = this.now().toISOString();
    this.db
      .prepare("INSERT INTO accounts (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)")
      .run(id, normalized, hashPassword(password), createdAt);
    return { id, email: normalized, createdAt, tokenVersion: 1, lastCycleAt: null };
  }

  verifyLogin(email: string, password: string): Account | null {
    const row = this.db.prepare("SELECT * FROM accounts WHERE email = ?").get(normalizeEmail(email) ?? "") as AccountRow | undefined;
    // Always run one scrypt so a missing account and a wrong password take the same time.
    const ok = verifyPassword(password, row?.password_hash ?? DUMMY_HASH);
    if (!row || !ok) {
      return null;
    }
    this.db.prepare("UPDATE accounts SET last_login_at = ? WHERE id = ?").run(this.now().toISOString(), row.id);
    return toAccount(row);
  }

  get(id: string): Account | null {
    const row = this.db.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as AccountRow | undefined;
    return row ? toAccount(row) : null;
  }

  findByEmail(email: string): Account | null {
    const row = this.db.prepare("SELECT * FROM accounts WHERE email = ?").get(email) as AccountRow | undefined;
    return row ? toAccount(row) : null;
  }

  list(): Account[] {
    return (this.db.prepare("SELECT * FROM accounts ORDER BY created_at").all() as unknown as AccountRow[]).map(toAccount);
  }

  count(): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM accounts").get() as { n: number }).n);
  }

  markCycle(id: string, at: string): void {
    this.db.prepare("UPDATE accounts SET last_cycle_at = ? WHERE id = ?").run(at, id);
  }

  rotateToken(id: string): void {
    this.db.prepare("UPDATE accounts SET token_version = token_version + 1 WHERE id = ?").run(id);
  }

  deleteAccount(id: string): void {
    this.db.prepare("DELETE FROM sessions WHERE account_id = ?").run(id);
    this.db.prepare("DELETE FROM accounts WHERE id = ?").run(id);
    // Grants and their tokens are keyed by user id inside the OAuth KV.
    this.db.prepare("DELETE FROM kv WHERE key LIKE ? OR key LIKE ?").run(`grant:${id}:%`, `token:${id}:%`);
  }

  // --- per-tenant secrets -----------------------------------------------------
  //
  // Derived, never stored: HMAC of the server secret. The tenant "admin token" is the key material
  // for its encrypted source credentials (ADR-0039) and its CSRF tokens; the personal access token
  // is the door bearer for clients without OAuth. Rotating UNICORN_SECRET invalidates both — and
  // with them every stored source credential — exactly like rotating ADMIN_TOKEN on a Worker.

  tenantAdminToken(id: string): string {
    return createHmac("sha256", this.secret).update(`tenant-admin:${id}`).digest("hex");
  }

  personalToken(account: Account): string {
    const mac = createHmac("sha256", this.secret).update(`pat:${account.id}:${account.tokenVersion}`).digest("base64url").slice(0, 32);
    return `uni_${account.id}_${mac}`;
  }

  resolvePersonalToken(token: string): Account | null {
    const match = token.match(/^uni_(t[0-9a-f]{20})_[A-Za-z0-9_-]{32}$/);
    if (!match) return null;
    const account = this.get(match[1]!);
    if (!account) return null;
    const expected = Buffer.from(this.personalToken(account));
    const given = Buffer.from(token);
    return expected.length === given.length && timingSafeEqual(expected, given) ? account : null;
  }

  // --- sessions ---------------------------------------------------------------

  createSession(accountId: string): { token: string; expiresAt: Date } {
    const token = randomBytes(32).toString("base64url");
    const now = this.now();
    const expiresAt = new Date(now.getTime() + SESSION_DAYS * 86_400_000);
    this.db
      .prepare("INSERT INTO sessions (token_hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .run(sha256(token), accountId, now.toISOString(), expiresAt.toISOString());
    return { token, expiresAt };
  }

  sessionAccount(token: string | null): Account | null {
    if (!token) return null;
    const row = this.db
      .prepare("SELECT a.* FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = ? AND s.expires_at > ?")
      .get(sha256(token), this.now().toISOString()) as AccountRow | undefined;
    return row ? toAccount(row) : null;
  }

  deleteSession(token: string): void {
    this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
  }

  pruneSessions(): void {
    this.db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(this.now().toISOString());
    this.db.prepare("DELETE FROM kv WHERE expires_at IS NOT NULL AND expires_at <= ?").run(Math.floor(this.now().getTime() / 1000));
  }

  // --- KV (the OAuth provider's store) ----------------------------------------

  kv(): KVNamespace {
    return new SqliteKv(this.db, () => this.now()) as unknown as KVNamespace;
  }
}

export class AccountError extends Error {
  constructor(
    readonly code: "invalid_email" | "weak_password" | "email_taken",
    message: string,
  ) {
    super(message);
    this.name = "AccountError";
  }
}

// Implements the subset of Workers KV that @cloudflare/workers-oauth-provider uses: get (text or
// json), put (with expirationTtl / expiration), delete, and prefix list with a cursor.
class SqliteKv {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => Date,
  ) {}

  private nowSeconds(): number {
    return Math.floor(this.now().getTime() / 1000);
  }

  async get(key: string, options?: { type?: string } | string): Promise<unknown> {
    const row = this.db.prepare("SELECT value, expires_at FROM kv WHERE key = ?").get(key) as { value: string; expires_at: number | null } | undefined;
    if (!row || (row.expires_at !== null && row.expires_at <= this.nowSeconds())) {
      return null;
    }
    const type = typeof options === "string" ? options : options?.type;
    return type === "json" ? JSON.parse(row.value) : row.value;
  }

  async put(key: string, value: string, options?: { expirationTtl?: number; expiration?: number }): Promise<void> {
    const expiresAt = options?.expiration ?? (options?.expirationTtl ? this.nowSeconds() + options.expirationTtl : null);
    this.db
      .prepare("INSERT INTO kv (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at")
      .run(key, String(value), expiresAt);
  }

  async delete(key: string): Promise<void> {
    this.db.prepare("DELETE FROM kv WHERE key = ?").run(key);
  }

  async list(options: { prefix?: string; limit?: number; cursor?: string | null } = {}): Promise<{
    keys: Array<{ name: string; expiration?: number }>;
    list_complete: boolean;
    cursor?: string;
  }> {
    const prefix = options.prefix ?? "";
    const limit = Math.min(options.limit ?? 1000, 1000);
    const after = options.cursor ? Buffer.from(options.cursor, "base64url").toString("utf8") : "";
    const rows = this.db
      .prepare(
        `SELECT key, expires_at FROM kv
         WHERE key >= ? AND key < ? AND key > ? AND (expires_at IS NULL OR expires_at > ?)
         ORDER BY key LIMIT ?`,
      )
      .all(prefix, `${prefix}￿`, after, this.nowSeconds(), limit + 1) as Array<{ key: string; expires_at: number | null }>;
    const page = rows.slice(0, limit);
    const complete = rows.length <= limit;
    return {
      keys: page.map((row) => (row.expires_at === null ? { name: row.key } : { name: row.key, expiration: row.expires_at })),
      list_complete: complete,
      ...(complete ? {} : { cursor: Buffer.from(page.at(-1)!.key, "utf8").toString("base64url") }),
    };
  }
}

function toAccount(row: AccountRow): Account {
  return { id: row.id, email: row.email, createdAt: row.created_at, tokenVersion: Number(row.token_version), lastCycleAt: row.last_cycle_at };
}

function normalizeEmail(email: string): string | null {
  const trimmed = email.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed) && trimmed.length <= 254 ? trimmed : null;
}

function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [scheme, n, r, p, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const actual = scryptSync(password, Buffer.from(salt, "base64"), expected.length, { N: Number(n), r: Number(r), p: Number(p) });
  return timingSafeEqual(expected, actual);
}

const DUMMY_HASH = hashPassword(randomBytes(12).toString("hex"));

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
