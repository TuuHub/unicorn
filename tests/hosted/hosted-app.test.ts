import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createHostedApp } from "../../server/app";
import { ControlStore } from "../../server/control";
import { HostedScheduler } from "../../server/scheduler";
import { TenantManager } from "../../server/tenants";
import { D1SourceCredentialStore } from "../../src/sources";

const ORIGIN = "https://unicorn.example.test";
const MIGRATIONS = path.resolve(__dirname, "../../migrations");

function setup(options: { signupCode?: string; maxAccounts?: number } = {}) {
  const control = new ControlStore(new DatabaseSync(":memory:"), "s".repeat(40));
  const tenants = new TenantManager(DatabaseSync, control, { dataDir: ":memory:", migrationsDir: MIGRATIONS, moodleBaseUrl: "https://learning.monash.edu" }, control.kv());
  const app = createHostedApp({
    control,
    tenants,
    config: { publicUrl: ORIGIN, operator: "Test Operator", repoUrl: "https://github.com/TuuHub/unicorn", signupOpen: true, ...options },
    log: () => undefined,
  });
  return { control, tenants, app };
}

function form(pathname: string, fields: Record<string, string>, cookie?: string): Request {
  return new Request(`${ORIGIN}${pathname}`, {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) },
    body: new URLSearchParams(fields).toString(),
  });
}

async function signup(app: ReturnType<typeof setup>["app"], email: string): Promise<string> {
  const response = await app.fetch(form("/signup", { email, password: "correct-horse-1", next: "/panel" }));
  expect(response.status).toBe(303);
  const cookie = response.headers.get("set-cookie")!;
  return cookie.split(";")[0]!;
}

function rpc(token: string, method: string, params: unknown) {
  return new Request(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

describe("hosted multi-tenant server", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it("serves the landing page publicly and the panel only when signed in", async () => {
    const landing = await ctx.app.fetch(new Request(`${ORIGIN}/`));
    expect(landing.status).toBe(200);
    const door = await landing.text();
    expect(door).toContain("data-horn");
    expect(door).toContain('action="/login"');
    const anonymous = await ctx.app.fetch(new Request(`${ORIGIN}/panel`));
    expect(anonymous.status).toBe(303);
    expect(anonymous.headers.get("location")).toBe("/login?next=%2Fpanel");

    const cookie = await signup(ctx.app, "a@uni.edu");
    expect(cookie.startsWith("__Host-unicorn_session=")).toBe(true);
    for (const page of ["/panel", "/panel/activity", "/panel/memory", "/panel/connect", "/settings", "/account"]) {
      const response = await ctx.app.fetch(new Request(`${ORIGIN}${page}`, { headers: { cookie } }));
      expect(response.status, page).toBe(200);
    }
  });

  it("keeps tenants isolated: each personal token reaches only its own memory", async () => {
    await signup(ctx.app, "a@uni.edu");
    await signup(ctx.app, "b@uni.edu");
    const [a, b] = ctx.control.list();
    const tokenA = ctx.control.personalToken(a!);
    const tokenB = ctx.control.personalToken(b!);

    const write = await ctx.app.fetch(rpc(tokenA, "tools/call", { name: "memory", arguments: { target: "user", operations: [{ action: "add", content: "Alice studies FIT3175" }] } }));
    expect(write.status).toBe(200);
    const readB = await (await ctx.app.fetch(rpc(tokenB, "tools/call", { name: "get_memory", arguments: {} }))).json();
    expect(JSON.stringify(readB)).not.toContain("Alice");
    const readA = await (await ctx.app.fetch(rpc(tokenA, "tools/call", { name: "get_memory", arguments: {} }))).json();
    expect(JSON.stringify(readA)).toContain("Alice studies FIT3175");

    const forged = await ctx.app.fetch(rpc(tokenA.slice(0, -2) + "xx", "tools/call", { name: "get_memory", arguments: {} }));
    expect(forged.status).toBe(401);
  });

  it("rotating the personal token revokes the old one", async () => {
    await signup(ctx.app, "a@uni.edu");
    const account = ctx.control.list()[0]!;
    const old = ctx.control.personalToken(account);
    ctx.control.rotateToken(account.id);
    expect((await ctx.app.fetch(rpc(old, "tools/list", {}))).status).toBe(401);
    expect((await ctx.app.fetch(rpc(ctx.control.personalToken(ctx.control.get(account.id)!), "tools/list", {}))).status).toBe(200);
  });

  it("asks for sign-in inside the OAuth pop-up and never on a bare POST", async () => {
    const page = await ctx.app.fetch(new Request(`${ORIGIN}/authorize?response_type=code&client_id=x`));
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("An app wants to connect");
    const post = await ctx.app.fetch(form("/authorize", { action: "approve" }));
    expect(post.status).toBe(401);
  });

  it("rejects bad sign-ins, cross-origin posts and open redirects", async () => {
    await signup(ctx.app, "a@uni.edu");
    const wrong = await ctx.app.fetch(form("/login", { email: "a@uni.edu", password: "nope-nope-nope" }));
    expect(wrong.status).toBe(400);
    const crossOrigin = await ctx.app.fetch(
      new Request(`${ORIGIN}/login`, { method: "POST", headers: { origin: "https://evil.test", "content-type": "application/x-www-form-urlencoded" }, body: "email=a%40uni.edu&password=correct-horse-1" }),
    );
    expect(crossOrigin.status).toBe(403);
    const redirect = await ctx.app.fetch(form("/login", { email: "a@uni.edu", password: "correct-horse-1", next: "//evil.test/x" }));
    expect(redirect.headers.get("location")).toBe("/panel");
    const duplicate = await ctx.app.fetch(form("/signup", { email: "A@uni.edu", password: "correct-horse-1" }));
    expect(await duplicate.text()).toContain("already exists");
  });

  it("enforces an invite code when configured", async () => {
    const invite = setup({ signupCode: "monash-2026" });
    const denied = await invite.app.fetch(form("/signup", { email: "a@uni.edu", password: "correct-horse-1", code: "wrong" }));
    expect(await denied.text()).toContain("invite code");
    const ok = await invite.app.fetch(form("/signup", { email: "a@uni.edu", password: "correct-horse-1", code: "monash-2026" }));
    expect(ok.status).toBe(303);
  });

  it("accepts a pushed Moodle session with the personal token and stores it encrypted", async () => {
    await signup(ctx.app, "a@uni.edu");
    const account = ctx.control.list()[0]!;
    const token = ctx.control.personalToken(account);
    const response = await ctx.app.fetch(
      new Request(`${ORIGIN}/api/sources/moodle/session`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ session: "abc123" }) }),
    );
    expect(response.status).toBe(200);
    const env = ctx.tenants.env(account.id);
    const stored = await new D1SourceCredentialStore(env.DB, env.ADMIN_TOKEN).get("moodle");
    expect(stored).toEqual({ status: "ok", fields: { baseUrl: "https://learning.monash.edu", session: "abc123" } });
    const raw = await env.DB.prepare("SELECT ciphertext FROM source_credentials").first<{ ciphertext: string }>();
    expect(raw!.ciphertext).not.toContain("abc123");
  });

  it("deletes the account, its grants and its database", async () => {
    const cookie = await signup(ctx.app, "a@uni.edu");
    const account = ctx.control.list()[0]!;
    const csrf = (await (await ctx.app.fetch(new Request(`${ORIGIN}/account`, { headers: { cookie } }))).text()).match(/name="csrf" value="([^"]+)"/)![1]!;
    const mismatch = await ctx.app.fetch(form("/account/delete", { csrf, confirm: "other@uni.edu" }, cookie));
    expect(mismatch.status).toBe(400);
    const deleted = await ctx.app.fetch(form("/account/delete", { csrf, confirm: "a@uni.edu" }, cookie));
    expect(deleted.status).toBe(303);
    expect(ctx.control.get(account.id)).toBeNull();
    expect((await ctx.app.fetch(rpc(ctx.control.personalToken(account), "tools/list", {}))).status).toBe(401);
  });

  it("runs each tenant's cycle once per hour", async () => {
    await signup(ctx.app, "a@uni.edu");
    await signup(ctx.app, "b@uni.edu");
    const ran: string[] = [];
    let now = new Date("2026-11-06T10:00:00.000Z");
    const scheduler = new HostedScheduler({
      control: ctx.control,
      tenants: ctx.tenants,
      now: () => now,
      log: () => undefined,
      runCycle: async (env) => {
        ran.push(env.DOOR_USER_ID!);
        return { at: now.toISOString(), skipped: false, sources: [], labeled: 0, digest: { status: "skipped", reason: "empty" }, archived: 0 };
      },
    });
    expect(await scheduler.tick()).toBe(2);
    expect(await scheduler.tick()).toBe(0);
    now = new Date(Date.now() + 2 * 60 * 60 * 1000);
    expect(await scheduler.tick()).toBe(2);
    expect(ran).toHaveLength(4);
  });
});
