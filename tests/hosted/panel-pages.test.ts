import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createHostedApp } from "../../server/app";
import { ControlStore } from "../../server/control";
import { TenantManager } from "../../server/tenants";

const ORIGIN = "https://unicorn.example.test";
const MIGRATIONS = path.resolve(__dirname, "../../migrations");

function setup() {
  const control = new ControlStore(new DatabaseSync(":memory:"), "s".repeat(40));
  const tenants = new TenantManager(DatabaseSync, control, { dataDir: ":memory:", migrationsDir: MIGRATIONS, moodleBaseUrl: "https://learning.monash.edu" }, control.kv());
  const app = createHostedApp({
    control,
    tenants,
    config: { publicUrl: ORIGIN, operator: "Test Operator", repoUrl: "https://github.com/TuuHub/unicorn", signupOpen: true },
    log: () => undefined,
  });
  return { control, tenants, app };
}

function post(pathname: string, fields: Record<string, string>, cookie?: string): Request {
  return new Request(`${ORIGIN}${pathname}`, {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) },
    body: new URLSearchParams(fields).toString(),
  });
}

describe("panel pages", () => {
  let ctx: ReturnType<typeof setup>;
  let cookie: string;
  let db: D1Database;
  const get = (page: string) => ctx.app.fetch(new Request(`${ORIGIN}${page}`, { headers: { cookie } }));

  beforeEach(async () => {
    ctx = setup();
    const response = await ctx.app.fetch(post("/signup", { email: "a@uni.edu", password: "correct-horse-1", next: "/panel" }));
    cookie = response.headers.get("set-cookie")!.split(";")[0]!;
    db = ctx.tenants.env(ctx.control.list()[0]!.id).DB;
    const now = new Date().toISOString();
    await db
      .prepare("INSERT INTO items (source, item_id, kind, title, timestamp, url, body, raw_json, created_at, updated_at, course) VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?)")
      .bind("campus-ed", "t1", "thread", "Assignment 3 clarification", now, "https://edstem.org/t1", "Staff: use Dijkstra, not BFS", now, now, "FIT2004")
      .run();
    await db
      .prepare("INSERT INTO changes (type, source, item_id, kind, title, url, field, before_json, after_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind("deadline.changed", "campus-ed", "t1", "thread", "Assignment 3 clarification", null, "dueAt", '"2026-11-10T12:00:00Z"', '"2026-11-12T12:00:00Z"', now)
      .run();
    await db
      .prepare("INSERT INTO plans (id, kind, subject, content, created_at, updated_at) VALUES (?, 'weekly', ?, ?, ?, ?)")
      .bind("weekly:2026-W45", "2026-W45", "## Monday\n- [ ] Read the A3 spec\n- [x] Quiz 9", now, now)
      .run();
    await db.prepare("INSERT INTO briefs (id, kind, subject, title, body, created_at) VALUES ('b1', 'digest', 'today', 'Morning digest', '**3** new posts', ?)").bind(now).run();
  });

  it("serves every page to a signed-in student", async () => {
    for (const page of ["/panel/changes", "/panel/due", "/panel/units", "/panel/briefs", "/panel/plans?week=2026-W45", "/panel/search?q=Dijkstra", "/panel/playbooks"]) {
      const response = await get(page);
      expect(response.status, page).toBe(200);
    }
  });

  it("shows a moved deadline with its before and after", async () => {
    const html = await (await get("/panel/changes?type=deadlines")).text();
    expect(html).toContain("Assignment 3 clarification");
    expect(html).toContain("Deadline moved");
    expect(html).toContain("<s>");
  });

  it("marks briefs read", async () => {
    const page = await (await get("/panel/briefs")).text();
    const csrf = page.match(/name="csrf" value="([^"]+)"/)![1]!;
    const response = await ctx.app.fetch(post("/panel/briefs/read", { csrf, all: "1" }, cookie));
    expect(response.status).toBe(303);
    const row = await db.prepare("SELECT read_at FROM briefs WHERE id = 'b1'").first<{ read_at: string | null }>();
    expect(row?.read_at).toBeTruthy();
  });

  it("ticks a plan item only when the line still says what the student saw", async () => {
    const page = await (await get("/panel/plans?week=2026-W45")).text();
    const csrf = page.match(/name="csrf" value="([^"]+)"/)![1]!;
    const base = { csrf, kind: "weekly", subject: "2026-W45", back: "/panel/plans?week=2026-W45" };
    await ctx.app.fetch(post("/panel/plans/toggle", { ...base, line: "1", text: "Something else" }, cookie));
    let plan = await db.prepare("SELECT content FROM plans WHERE subject = '2026-W45'").first<{ content: string }>();
    expect(plan?.content).toContain("- [ ] Read the A3 spec");
    await ctx.app.fetch(post("/panel/plans/toggle", { ...base, line: "1", text: "Read the A3 spec" }, cookie));
    plan = await db.prepare("SELECT content FROM plans WHERE subject = '2026-W45'").first<{ content: string }>();
    expect(plan?.content).toContain("- [x] Read the A3 spec");
  });

  it("exports a calendar and the student's own data", async () => {
    const ics = await get("/panel/due.ics");
    expect(ics.headers.get("content-type")).toContain("text/calendar");
    expect(await ics.text()).toContain("BEGIN:VCALENDAR");
    const exported = await get("/panel/export");
    expect(exported.headers.get("content-disposition")).toContain("attachment");
    const data = (await exported.json()) as { plans: unknown[]; briefs: unknown[] };
    expect(data.plans).toHaveLength(1);
    expect(data.briefs).toHaveLength(1);
  });

  it("sends a hosted student from Deployment to Account", async () => {
    const response = await get("/panel/deployment");
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain("/account");
    const html = await (await get("/panel")).text();
    expect(html).toContain('href="/account"');
    expect(html).not.toContain('href="/panel/deployment"');
  });
});
