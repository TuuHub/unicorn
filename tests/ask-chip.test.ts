import { describe, expect, it } from "vitest";
import { askChip } from "../src/panel-kit";

describe("askChip", () => {
  it("opens the line as a new Claude or ChatGPT chat and offers to copy it", () => {
    const html = askChip("Break FIT2004 A3 & notes into daily tasks.");
    const q = encodeURIComponent("Break FIT2004 A3 & notes into daily tasks.");

    expect(html).toContain(`href="https://claude.ai/new?q=${q}"`);
    expect(html).toContain(`href="https://chatgpt.com/?q=${q}"`);
    expect(html).toContain('data-copy="Break FIT2004 A3 &amp; notes into daily tasks."');
  });
});
