import { describe, expect, it } from "vitest";
import { D1ItemStore } from "../src/kernel/d1-item-store";
import { Kernel } from "../src/kernel/kernel";
import { labelStructure } from "../src/kernel/courses";
import { D1DoorRepository } from "../src/mcp/door-repository";
import { handlePanel, type PanelRuntime } from "../src/panel";
import { computeCsrfToken } from "../src/settings";
import { loadTermCourses } from "../src/term";
import { buildMixedDataset } from "./support/dataset";
import { createTestDb } from "./support/sqlite-d1";

const ORIGIN = "https://unicorn.example";

describe("moving an item on a unit page", () => {
  it("files it where the user put it, and the structure pass leaves it there", async () => {
    const db = await createTestDb();
    await new Kernel(new D1ItemStore(db)).ingest(await buildMixedDataset());
    await labelStructure(db);
    const repo = new D1DoorRepository(db);
    const runtime = { db, adminToken: "admin-secret", repo, timezone: "Australia/Melbourne" } as unknown as PanelRuntime;
    const [course] = await loadTermCourses(db);
    const view = await repo.course(course!.code);
    const general = `course/${view.code}/general`;
    const item = view.buckets.find((bucket) => bucket.bucket !== general && bucket.items.length)!.items[0]!;

    const page = await (await handlePanel(new Request(`${ORIGIN}/panel/units/${view.code}`), runtime)).text();
    expect(page).toContain('action="/panel/label"');

    const body = new URLSearchParams({ csrf: await computeCsrfToken("admin-secret"), source: item.source, itemId: item.itemId, bucket: general, code: view.code! });
    const response = await handlePanel(new Request(`${ORIGIN}/panel/label`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" }, body }), runtime);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/panel/units/${view.code}?moved=1`);

    await labelStructure(db);
    const after = await repo.course(view.code!);
    const moved = after.buckets.find((bucket) => bucket.bucket === general)!.items.find((entry) => entry.itemId === item.itemId);
    expect(moved).toMatchObject({ bucket: general, labeledBy: "client" });
  });
});
