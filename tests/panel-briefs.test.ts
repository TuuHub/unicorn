import { describe, expect, it } from "vitest";
import { D1BriefStore } from "../src/briefs";
import { handlePanel, type PanelRuntime } from "../src/panel";
import { computeCsrfToken } from "../src/settings";
import { createTestDb } from "./support/sqlite-d1";

const ORIGIN = "https://unicorn.example";
const NOW = new Date("2026-11-06T09:00:00.000Z");

describe("briefs page", () => {
  it("puts a brief an agent marked read back into the unread inbox", async () => {
    const db = await createTestDb();
    const briefs = new D1BriefStore(db, () => NOW);
    const runtime = { db, adminToken: "admin-secret", briefs, timezone: "Australia/Melbourne", now: () => NOW } as unknown as PanelRuntime;
    await briefs.insert({ id: "routine:weekly-plan:2026-W45", kind: "weekly-plan", subject: "2026-W45", title: "Weekly plan", body: "- [ ] A2" });
    await briefs.markRead(["routine:weekly-plan:2026-W45"]);

    const page = await (await handlePanel(new Request(`${ORIGIN}/panel/briefs`), runtime)).text();
    expect(page).toContain("Mark unread");

    const body = new URLSearchParams({ csrf: await computeCsrfToken("admin-secret"), id: "routine:weekly-plan:2026-W45" });
    const response = await handlePanel(new Request(`${ORIGIN}/panel/briefs/unread`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" }, body }), runtime);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/panel/briefs?unread=1`);
    expect((await briefs.list({ unreadOnly: true })).map((brief) => brief.id)).toEqual(["routine:weekly-plan:2026-W45"]);
  });
});
