import { describe, expect, it } from "vitest";
import { D1ActivityLog } from "../src/activity";
import { readAllMemory, trackMemoryWrite, writeMemory } from "../src/agent-memory";
import { D1MemoryStore } from "../src/memory";
import { handlePanel, type PanelRuntime } from "../src/panel";
import { computeCsrfToken } from "../src/settings";
import { createTestDb } from "./support/sqlite-d1";

const ORIGIN = "https://unicorn.example";
const NOW = new Date("2026-11-06T09:00:00.000Z");

async function setup() {
  const db = await createTestDb();
  const memory = new D1MemoryStore(db, () => NOW);
  const activity = new D1ActivityLog(db, () => NOW);
  const runtime = { db, adminToken: "admin-secret", memory, activity, now: () => NOW } as unknown as PanelRuntime;
  return { memory, activity, runtime };
}

async function post(path: string, fields: Record<string, string>, runtime: PanelRuntime): Promise<Response> {
  const body = new URLSearchParams({ ...fields, csrf: await computeCsrfToken("admin-secret") });
  return handlePanel(new Request(`${ORIGIN}${path}`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" }, body }), runtime);
}

async function entries(memory: D1MemoryStore, target: string): Promise<string[]> {
  return (await readAllMemory(memory)).find((view) => view.target === target)!.entries;
}

describe("memory page", () => {
  it("adds, edits and deletes one entry at a time, logging each as the panel", async () => {
    const { memory, activity, runtime } = await setup();

    const added = await post("/panel/memory/notes", { op: "add", content: "Studies with Alex on Tuesdays" }, runtime);
    expect(added.status).toBe(303);
    expect(added.headers.get("location")).toBe(`${ORIGIN}/panel/memory?saved=added#mem-notes`);

    await post("/panel/memory/notes", { op: "edit", old: "Studies with Alex on Tuesdays", content: "Studies with Alex on Wednesdays" }, runtime);
    expect(await entries(memory, "notes")).toEqual(["Studies with Alex on Wednesdays"]);

    await post("/panel/memory/notes", { op: "remove", old: "Studies with Alex on Wednesdays" }, runtime);
    expect(await entries(memory, "notes")).toEqual([]);

    const log = await activity.list({ kind: "memory" });
    expect(log.map((entry) => entry.detail)).toEqual([
      { added: [], removed: ["Studies with Alex on Wednesdays"] },
      { added: ["Studies with Alex on Wednesdays"], removed: ["Studies with Alex on Tuesdays"] },
      { added: ["Studies with Alex on Tuesdays"], removed: [] },
    ]);
    expect(log[0]).toMatchObject({ via: "panel", actor: null });
  });

  it("keeps a correction's date when its text is edited", async () => {
    const { memory, runtime } = await setup();
    await writeMemory(memory, "corrections", [{ action: "add", content: "quizzes don't count" }], { now: new Date("2026-10-02T00:00:00Z") });

    await post("/panel/memory/corrections", { op: "edit", old: "- [2026-10-02] quizzes don't count", content: "FIT2099 quizzes don't count" }, runtime);
    expect(await entries(memory, "corrections")).toEqual(["- [2026-10-02] FIT2099 quizzes don't count"]);
  });

  it("says so in the card when the entry changed underneath the form", async () => {
    const { runtime } = await setup();
    const response = await post("/panel/memory/user", { op: "remove", old: "gone" }, runtime);
    expect(response.headers.get("location")).toContain("target=user#mem-user");

    const page = await (await handlePanel(new Request(response.headers.get("location")!), runtime)).text();
    expect(page).toMatch(/id="mem-user"[\s\S]*changed since the page loaded[\s\S]*id="mem-notes"/);
  });

  it("shows an agent's change and undoes it", async () => {
    const { memory, activity, runtime } = await setup();
    await writeMemory(memory, "user", [{ action: "add", content: "Year 2 IT" }]);
    await trackMemoryWrite(memory, activity, "user", { actor: "Claude", via: "oauth" }, () =>
      writeMemory(memory, "user", [{ action: "patch", old_text: "Year 2 IT", content: "Year 3 IT" }]),
    );

    const page = await (await handlePanel(new Request(`${ORIGIN}/panel/memory`), runtime)).text();
    expect(page).toContain("<strong>Claude</strong> <span class=\"muted\">edited User profile</span>");
    expect(page).toContain("Year 3 IT");
    expect(page).not.toContain('role="meter"');
    const [change] = await activity.list({ kind: "memory" });

    const undone = await post("/panel/memory/undo", { id: String(change!.id) }, runtime);
    expect(undone.headers.get("location")).toContain("saved=undone");
    expect(await entries(memory, "user")).toEqual(["Year 2 IT"]);

    const after = await (await handlePanel(new Request(`${ORIGIN}/panel/memory`), runtime)).text();
    expect(after).toContain("undid a change to User profile");
    expect(after).toContain("Undone</span>");
  });
});
