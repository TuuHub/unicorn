import { describe, expect, it, vi } from "vitest";
import type { LoginBrowser } from "../src/moodle-browser";
import { D1ManifestStore } from "../src/plugins/declarative/store";
import { computeCsrfToken, D1SettingsRepository, handleSettings, type SettingsRuntime } from "../src/settings";
import type { SourceCredentialStore, SourceId } from "../src/sources";
import { createTestDb } from "./support/sqlite-d1";

const ORIGIN = "https://unicorn.example";

const FEED = {
  version: 1,
  id: "faculty-news",
  name: "Faculty news",
  format: "rss",
  url: "https://example.edu/feed.xml",
  mapping: { id: { path: "guid" }, kind: { value: "announcement" }, title: { path: "title" }, timestamp: { path: "publishedAt" } },
};

async function post(path: string, fields: Record<string, string>, runtime: SettingsRuntime): Promise<Response> {
  const body = new URLSearchParams({ ...fields, csrf: await computeCsrfToken("admin-secret") });
  return handleSettings(new Request(`${ORIGIN}${path}`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" }, body }), runtime);
}

function memoryCredentials(): SourceCredentialStore & { saved: Map<SourceId, Record<string, string>> } {
  const saved = new Map<SourceId, Record<string, string>>();
  return {
    saved,
    get: async (id) => (saved.has(id) ? { status: "ok", fields: saved.get(id)! } : { status: "none" }),
    save: async (id, fields) => void saved.set(id, fields),
    delete: async (id) => void saved.delete(id),
  };
}

async function setup(extra: Partial<SettingsRuntime> = {}) {
  const db = await createTestDb();
  const runtime: SettingsRuntime = {
    adminToken: "admin-secret",
    repository: new D1SettingsRepository(db),
    sourceEnv: { MOODLE_BASE_URL: "https://moodle.example.edu" },
    credentials: memoryCredentials(),
    lastCycle: { at: null, byPlugin: {} },
    itemCounts: {},
    mcpToken: "mcp-secret",
    connections: { mcp: true },
    status: { schedulerRunning: true },
    db,
    ...extra,
  };
  return { db, runtime };
}

describe("custom sources", () => {
  it("adds a valid manifest and renders it as a card", async () => {
    const { db, runtime } = await setup();
    const response = await post("/settings/plugins", { manifest: JSON.stringify(FEED) }, runtime);

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain("#plugin-faculty-news");
    expect((await new D1ManifestStore(db).list()).map((stored) => stored.id)).toEqual(["faculty-news"]);

    const page = await (await handleSettings(new Request(`${ORIGIN}/settings`), runtime)).text();
    expect(page).toContain('id="plugin-faculty-news"');
    expect(page).toContain("Reads the feed from example.edu.");
  });

  it("puts a bad manifest back in the box with the first problem", async () => {
    const { runtime } = await setup();
    const response = await post("/settings/plugins", { manifest: JSON.stringify({ ...FEED, url: "http://example.edu/feed.xml" }) }, runtime);
    const html = await response.text();

    expect(response.status).toBe(400);
    expect(html).toContain("In &quot;url&quot;: Plugin URLs must use HTTPS.");
    expect(html).toContain("http://example.edu/feed.xml");
  });

  it("rejects JSON that does not parse and ids that belong to built-in sources", async () => {
    const { runtime } = await setup();

    expect(await (await post("/settings/plugins", { manifest: "{" }, runtime)).text()).toContain("not valid JSON");
    expect(await (await post("/settings/plugins", { manifest: JSON.stringify({ ...FEED, id: "campus-ed" }) }, runtime)).text()).toContain("belongs to a built-in source");
  });

  it("pauses, resumes and removes a custom source", async () => {
    const { db, runtime } = await setup();
    const store = new D1ManifestStore(db);
    await store.upsert(FEED);

    await post("/settings/plugins/faculty-news/enabled", { enabled: "0" }, runtime);
    expect((await store.list())[0]?.enabled).toBe(false);
    await post("/settings/plugins/faculty-news/enabled", { enabled: "1" }, runtime);
    expect((await store.list())[0]?.enabled).toBe(true);

    await post("/settings/plugins/faculty-news/remove", {}, runtime);
    expect(await store.list()).toEqual([]);
  });

  it("keeps an edit on the same id", async () => {
    const { db, runtime } = await setup();
    await new D1ManifestStore(db).upsert(FEED);

    const renamed = await post("/settings/plugins/faculty-news", { manifest: JSON.stringify({ ...FEED, name: "Faculty updates" }) }, runtime);
    expect(renamed.status).toBe(303);
    expect((await new D1ManifestStore(db).list())[0]?.name).toBe("Faculty updates");

    const moved = await post("/settings/plugins/faculty-news", { manifest: JSON.stringify({ ...FEED, id: "other" }) }, runtime);
    expect(moved.status).toBe(400);
  });
});

describe("pausing a built-in source", () => {
  it("records the paused source in settings and clears it on resume", async () => {
    const { runtime } = await setup();

    await post("/settings/sources/moodle/enabled", { enabled: "0" }, runtime);
    expect((await runtime.repository.get()).disabledSources).toEqual(["moodle"]);

    await post("/settings/sources/moodle/enabled", { enabled: "1" }, runtime);
    expect((await runtime.repository.get()).disabledSources).toEqual([]);
  });
});

function fakeBrowser(cookie: { name: string; value: string } | null) {
  const browser = {
    closed: 0,
    open: vi.fn(async () => ({ sessionId: "s1", targetId: "t1", liveViewUrl: "https://live.example/view/s1" })),
    readMoodleCookie: vi.fn(async (): Promise<{ name: string; value: string } | null> => cookie),
    onLoginPage: vi.fn(async () => true),
    close: vi.fn(async () => {
      browser.closed += 1;
    }),
  };
  return browser satisfies LoginBrowser;
}

describe("Moodle sign-in", () => {

  const dashboard = vi.fn<typeof fetch>(async () => new Response('<script>M.cfg = {"sesskey":"abc"}</script>', { status: 200 }));

  it("offers the sign-in button only when a browser is bound", async () => {
    const without = await setup();
    await post("/settings/sources/moodle/add", {}, without.runtime);
    expect(await (await handleSettings(new Request(`${ORIGIN}/settings`), without.runtime)).text()).not.toContain("Open remote browser");

    const withBrowser = await setup({ browser: fakeBrowser(null) });
    await post("/settings/sources/moodle/add", {}, withBrowser.runtime);
    expect(await (await handleSettings(new Request(`${ORIGIN}/settings`), withBrowser.runtime)).text()).toContain("Open remote browser");
  });

  it("waits on the live view, then saves the session once the dashboard loads", async () => {
    const browser = fakeBrowser(null);
    const { runtime } = await setup({ browser, fetch: dashboard });
    const credentials = runtime.credentials as ReturnType<typeof memoryCredentials>;

    const started = await post("/settings/sources/moodle/sign-in", { baseUrl: "https://moodle.example.edu/" }, runtime);
    expect(started.status).toBe(303);
    expect(browser.open).toHaveBeenCalledWith("https://moodle.example.edu/my/", expect.any(Number));

    const waiting = await handleSettings(new Request(`${ORIGIN}/settings/sources/moodle/sign-in`), runtime);
    expect(waiting.headers.get("refresh")).toBe("4");
    expect(await waiting.text()).toContain('href="https://live.example/view/s1"');

    browser.readMoodleCookie.mockResolvedValue({ name: "MoodleSession", value: "fresh" });
    const done = await handleSettings(new Request(`${ORIGIN}/settings/sources/moodle/sign-in`), runtime);
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toContain("signedIn=moodle");
    expect(credentials.saved.get("moodle")).toEqual({ baseUrl: "https://moodle.example.edu", session: "fresh", cookieName: "MoodleSession" });
    expect(browser.closed).toBe(1);
  });

  it("cancels an attempt and closes its browser", async () => {
    const browser = fakeBrowser(null);
    const { runtime } = await setup({ browser, fetch: dashboard });

    await post("/settings/sources/moodle/sign-in", {}, runtime);
    const cancelled = await post("/settings/sources/moodle/sign-in/cancel", {}, runtime);

    expect(cancelled.status).toBe(303);
    expect(browser.closed).toBe(1);
    const after = await handleSettings(new Request(`${ORIGIN}/settings/sources/moodle/sign-in`), runtime);
    expect(after.headers.get("location")).toBe(`${ORIGIN}/settings#source-moodle`);
  });
});

describe("adding sources", () => {
  const page = async (runtime: SettingsRuntime, path = "/settings") => (await handleSettings(new Request(`${ORIGIN}${path}`), runtime)).text();

  it("starts empty, lists every built-in source in the catalog, and adds one with a way back", async () => {
    const { runtime } = await setup({ sourceEnv: { MOODLE_BASE_URL: "" } });
    expect(await page(runtime)).toContain("No sources yet");
    const catalog = await page(runtime, "/settings/sources/add");
    for (const name of ["Moodle", "Ed Discussion", "Gmail", "Canvas"]) expect(catalog).toContain(name);
    expect(catalog).toContain('action="/settings/sources/canvas/add"');

    const added = await post("/settings/sources/canvas/add", {}, runtime);
    expect(added.headers.get("location")).toContain("added=canvas#source-canvas");
    const html = await page(runtime);
    expect(html).toContain('id="source-canvas"');
    expect(html).not.toContain('id="source-ed"');
    expect(await page(runtime, "/settings/sources/add")).toContain('href="/settings#source-canvas"');

    await post("/settings/sources/canvas/disconnect", {}, runtime);
    expect(await page(runtime)).toContain("No sources yet");
  });

  it("leads with Okta only on a Moodle that sends sign-in to Okta", async () => {
    const okta = vi.fn(async () => new Response(null, { status: 303, headers: { location: "https://school.okta.com/app/moodle/sso/saml" } }));
    const viaOkta = await setup({ fetch: okta as unknown as typeof fetch });
    await post("/settings/sources/moodle/add", {}, viaOkta.runtime);
    const oktaHtml = await page(viaOkta.runtime);
    expect(oktaHtml).toContain("Your school signs in through Okta");
    expect(oktaHtml).not.toContain("My school signs in through Okta");
    await page(viaOkta.runtime);
    expect(okta).toHaveBeenCalledOnce(); // checked once, then remembered

    const plain = vi.fn(async () => new Response('<form><input name="password"></form>'));
    const elsewhere = await setup({ fetch: plain as unknown as typeof fetch, browser: fakeBrowser(null) });
    await post("/settings/sources/moodle/add", {}, elsewhere.runtime);
    const plainHtml = await page(elsewhere.runtime);
    expect(plainHtml).not.toContain("Your school signs in through Okta");
    expect(plainHtml).toContain("My school signs in through Okta");
    expect(plainHtml.indexOf("Open remote browser")).toBeLessThan(plainHtml.indexOf("My school signs in through Okta"));
  });
});
