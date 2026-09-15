import { describe, expect, it } from "vitest";
import { D1BriefStore, type Brief } from "../src/briefs";

interface Row {
  id: string;
  kind: string;
  subject: string;
  title: string;
  body: string;
  created_at: string;
  read_at: string | null;
}

// A tiny in-memory D1 double covering exactly the statements D1BriefStore issues.
function fakeDb(rows: Row[]) {
  return {
    prepare(sql: string) {
      const binder = {
        args: [] as unknown[],
        bind(...args: unknown[]) {
          this.args = args;
          return this;
        },
        async run() {
          if (sql.startsWith("INSERT INTO briefs")) {
            const [id, kind, subject, title, body, createdAt] = this.args as string[];
            if (rows.some((row) => row.id === id)) {
              return { meta: { changes: 0 } };
            }
            rows.push({ id, kind, subject, title, body, created_at: createdAt, read_at: null });
            return { meta: { changes: 1 } };
          }
          if (sql.startsWith("UPDATE briefs SET read_at")) {
            const [readAt, ...ids] = this.args as string[];
            let changes = 0;
            for (const row of rows) {
              if (ids.includes(row.id) && row.read_at === null) {
                row.read_at = readAt;
                changes += 1;
              }
            }
            return { meta: { changes } };
          }
          if (sql.startsWith("DELETE FROM briefs")) {
            const [cutoff] = this.args as [string];
            const before = rows.length;
            for (let index = rows.length - 1; index >= 0; index -= 1) {
              if (rows[index]!.created_at < cutoff) {
                rows.splice(index, 1);
              }
            }
            return { meta: { changes: before - rows.length } };
          }
          return { meta: { changes: 0 } };
        },
        async first<T>() {
          if (sql.startsWith("SELECT * FROM briefs WHERE id = ?")) {
            const [id] = this.args as [string];
            const row = rows.find((candidate) => candidate.id === id);
            return (row ?? null) as unknown as T;
          }
          if (sql.startsWith("SELECT 1 FROM briefs WHERE id = ?")) {
            const [id] = this.args as [string];
            return (rows.some((row) => row.id === id) ? { 1: 1 } : null) as unknown as T;
          }
          if (sql.startsWith("SELECT * FROM briefs WHERE kind = ?")) {
            const [kind] = this.args as [string];
            const match = rows
              .filter((row) => row.kind === kind)
              .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0];
            return (match ?? null) as unknown as T;
          }
          return null as unknown as T;
        },
        async all<T>() {
          if (sql.startsWith("SELECT * FROM briefs WHERE read_at IS NULL")) {
            const [limit] = this.args as [number];
            return {
              results: rows
                .filter((row) => row.read_at === null)
                .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
                .slice(0, limit) as unknown as T[],
            };
          }
          if (sql.startsWith("SELECT * FROM briefs ORDER BY created_at DESC")) {
            const [limit] = this.args as [number];
            return {
              results: rows.sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).slice(0, limit) as unknown as T[],
            };
          }
          return { results: [] as T[] };
        },
      };
      return binder;
    },
  } as unknown as D1Database;
}

function makeStore(rows: Row[] = [], now = () => new Date("2026-07-19T00:00:00.000Z")) {
  return new D1BriefStore(fakeDb(rows), now);
}

describe("D1BriefStore", () => {
  it("inserts a brief and returns it", async () => {
    const store = makeStore();

    const brief = await store.insert({
      id: "digest:2026-07-19",
      kind: "digest",
      subject: "2026-07-19",
      title: "unicorn daily digest",
      body: "Nothing urgent.",
    });

    expect(brief).toEqual<Brief>({
      id: "digest:2026-07-19",
      kind: "digest",
      subject: "2026-07-19",
      title: "unicorn daily digest",
      body: "Nothing urgent.",
      createdAt: "2026-07-19T00:00:00.000Z",
      readAt: null,
    });
  });

  it("is idempotent on the caller-provided id", async () => {
    const rows: Row[] = [];
    const store = makeStore(rows);

    await store.insert({ id: "forum-brief:2026-07-19", kind: "forum-brief", subject: "x", title: "a", body: "first" });
    const retried = await store.insert({
      id: "forum-brief:2026-07-19",
      kind: "forum-brief",
      subject: "x",
      title: "a",
      body: "second",
    });

    expect(rows).toHaveLength(1);
    expect(retried.body).toBe("first");
  });

  it("lists unread briefs newest first by default", async () => {
    const rows: Row[] = [
      { id: "a", kind: "digest", subject: "s", title: "t", body: "b", created_at: "2026-07-18T00:00:00.000Z", read_at: null },
      { id: "b", kind: "digest", subject: "s", title: "t", body: "b", created_at: "2026-07-19T00:00:00.000Z", read_at: null },
      { id: "c", kind: "digest", subject: "s", title: "t", body: "b", created_at: "2026-07-17T00:00:00.000Z", read_at: "2026-07-17T01:00:00.000Z" },
    ];
    const store = makeStore(rows);

    const briefs = await store.list();

    expect(briefs.map((brief) => brief.id)).toEqual(["b", "a"]);
  });

  it("lists every brief when unreadOnly is false", async () => {
    const rows: Row[] = [
      { id: "a", kind: "digest", subject: "s", title: "t", body: "b", created_at: "2026-07-18T00:00:00.000Z", read_at: null },
      { id: "c", kind: "digest", subject: "s", title: "t", body: "b", created_at: "2026-07-17T00:00:00.000Z", read_at: "2026-07-17T01:00:00.000Z" },
    ];
    const store = makeStore(rows);

    const briefs = await store.list({ unreadOnly: false });

    expect(briefs.map((brief) => brief.id)).toEqual(["a", "c"]);
  });

  it("marks briefs read and reports how many changed", async () => {
    const rows: Row[] = [
      { id: "a", kind: "digest", subject: "s", title: "t", body: "b", created_at: "2026-07-18T00:00:00.000Z", read_at: null },
      { id: "b", kind: "digest", subject: "s", title: "t", body: "b", created_at: "2026-07-18T00:00:00.000Z", read_at: "already" },
    ];
    const store = makeStore(rows);

    const changed = await store.markRead(["a", "b", "missing"]);

    expect(changed).toBe(1);
    expect(rows.find((row) => row.id === "a")?.read_at).toBe("2026-07-19T00:00:00.000Z");
  });

  it("checks existence by id", async () => {
    const rows: Row[] = [
      { id: "a", kind: "digest", subject: "s", title: "t", body: "b", created_at: "2026-07-18T00:00:00.000Z", read_at: null },
    ];
    const store = makeStore(rows);

    await expect(store.exists("a")).resolves.toBe(true);
    await expect(store.exists("missing")).resolves.toBe(false);
  });

  it("finds the latest brief of a kind", async () => {
    const rows: Row[] = [
      { id: "a", kind: "forum-brief", subject: "s", title: "t", body: "b", created_at: "2026-07-10T00:00:00.000Z", read_at: null },
      { id: "b", kind: "forum-brief", subject: "s", title: "t", body: "b", created_at: "2026-07-17T00:00:00.000Z", read_at: null },
      { id: "c", kind: "digest", subject: "s", title: "t", body: "b", created_at: "2026-07-19T00:00:00.000Z", read_at: null },
    ];
    const store = makeStore(rows);

    const latest = await store.latestByKind("forum-brief");

    expect(latest?.id).toBe("b");
  });

  it("prunes briefs past the retention window", async () => {
    const rows: Row[] = [
      { id: "old", kind: "digest", subject: "s", title: "t", body: "b", created_at: "2026-01-01T00:00:00.000Z", read_at: null },
      { id: "recent", kind: "digest", subject: "s", title: "t", body: "b", created_at: "2026-07-18T00:00:00.000Z", read_at: null },
    ];
    const store = makeStore(rows);

    const pruned = await store.prune(30);

    expect(pruned).toBe(1);
    expect(rows.map((row) => row.id)).toEqual(["recent"]);
  });
});
