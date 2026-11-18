import { describe, expect, it } from "vitest";
import { DEFAULT_BOARD, WIDGETS, handleBoardPost, loadBoard, parseBoard, renderBoard } from "../src/panel-board";
import { createTestDb } from "./support/sqlite-d1";

const url = new URL("https://unicorn.example/panel/board");

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

describe("parseBoard", () => {
  it("keeps known widgets once each, in order, and defaults a bad size to small", () => {
    expect(
      parseBoard([
        { id: "units", size: "l" },
        { id: "nope", size: "m" },
        { id: "due", size: "xl" },
        { id: "units", size: "s" },
        null,
      ]),
    ).toEqual([
      { id: "units", size: "l" },
      { id: "due", size: "s" },
    ]);
  });

  it("falls back to the default for anything that is not a list", () => {
    expect(parseBoard({ id: "due" })).toBe(DEFAULT_BOARD);
    expect(parseBoard(null)).toBe(DEFAULT_BOARD);
  });

  it("allows an empty board", () => {
    expect(parseBoard([])).toEqual([]);
  });
});

describe("handleBoardPost", () => {
  it("saves the edited layout and redirects to the overview", async () => {
    const db = await createTestDb();
    const response = await handleBoardPost(db, form({ layout: JSON.stringify([{ id: "grades", size: "m" }, { id: "due", size: "l" }]) }), url);

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://unicorn.example/panel");
    expect(await loadBoard(db)).toEqual([
      { id: "grades", size: "m" },
      { id: "due", size: "l" },
    ]);
  });

  it("resets to the default", async () => {
    const db = await createTestDb();
    await handleBoardPost(db, form({ layout: JSON.stringify([{ id: "grades", size: "m" }]) }), url);
    await handleBoardPost(db, form({ reset: "1" }), url);

    expect(await loadBoard(db)).toBe(DEFAULT_BOARD);
  });

  it("rejects a layout that is not JSON and keeps the saved one", async () => {
    const db = await createTestDb();
    const response = await handleBoardPost(db, form({ layout: "{" }), url);

    expect(response.status).toBe(400);
    expect(await loadBoard(db)).toBe(DEFAULT_BOARD);
  });
});

describe("renderBoard", () => {
  it("renders hidden widgets with the hidden attribute and offers them in the add tray", () => {
    const content = Object.fromEntries(Object.entries(WIDGETS).map(([id, title]) => [id, { title, body: "<p>body</p>" }]));
    const html = renderBoard([{ id: "due", size: "m" }], content as Parameters<typeof renderBoard>[1], "csrf-token");

    expect(html).toMatch(/data-widget="due"[^>]*data-size="m"/);
    expect(html).toMatch(/data-widget="grades"[^>]*hidden/);
    expect(html).toMatch(/data-add="grades"(?![^>]*hidden)/);
    expect(html).toMatch(/data-add="due"[^>]*hidden/);
  });
});
