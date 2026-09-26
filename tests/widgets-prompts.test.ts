import { describe, expect, it } from "vitest";
import { detectCapabilities } from "../src/widgets/bridge.js";
import {
  ackAllBriefsSummary,
  ackBriefSummary,
  askStaffOpinionPrompt,
  checklistToggleSummary,
  decomposeAssignmentPrompt,
  discussBriefPrompt,
  fixSourcePrompt,
  planAroundPrompt,
  replanRestPrompt,
  whatMattersPrompt,
} from "../src/widgets/prompts.js";

// Every prompt/summary builder is pure and must name the concrete id it is
// about — the model's next tool call should never have to guess which brief,
// item, or source a button meant.

describe("ask-action prompt builders", () => {
  it("discussBriefPrompt names the brief id and kind", () => {
    const brief = { id: "brief-1", kind: "digest", title: "Your Friday digest" };
    expect(discussBriefPrompt(brief)).toBe('Discuss the brief "Your Friday digest" (id brief-1, kind digest).');
  });

  it("decomposeAssignmentPrompt names the source:itemId and the bucket", () => {
    const prompt = decomposeAssignmentPrompt(
      { code: "FIT3175" },
      { label: "Assignment 2" },
      { source: "campus-canvas", itemId: "assess-882" },
    );
    expect(prompt).toBe("Run the decompose-assignment playbook for campus-canvas:assess-882 (FIT3175 — Assignment 2).");
  });

  it("askStaffOpinionPrompt names the course and bucket", () => {
    expect(askStaffOpinionPrompt({ code: "FIT3175" }, { label: "Assignment 2" })).toBe(
      "What do staff say about FIT3175 — Assignment 2?",
    );
  });

  it("whatMattersPrompt carries the event count and cursor", () => {
    expect(whatMattersPrompt({ events: [1, 2, 3], nextCursor: "418" })).toBe(
      "What matters in these 3 changes since cursor 418?",
    );
    expect(whatMattersPrompt({ events: [1], nextCursor: "1" })).toBe("What matters in these 1 change since cursor 1?");
  });

  it("planAroundPrompt names the item id and due date", () => {
    const item = { title: "Assignment 2", source: "campus-canvas", itemId: "assess-882", dueAt: "2026-10-06T09:00:00.000Z" };
    expect(planAroundPrompt(item)).toBe(
      'Help me plan around "Assignment 2" (campus-canvas:assess-882), due 2026-10-06T09:00:00.000Z.',
    );
  });

  it("replanRestPrompt lists only the remaining item texts", () => {
    const plan = { kind: "weekly", subject: "2026-W39" };
    expect(replanRestPrompt(plan, ["Submit peer review", "Read Ch. 9"])).toBe(
      "Replan the rest of week 2026-W39. Remaining:\n- Submit peer review\n- Read Ch. 9",
    );
  });

  it("replanRestPrompt says everything is done when nothing remains", () => {
    expect(replanRestPrompt({ kind: "assignment", subject: "FIT3175 A2" }, [])).toBe(
      "Replan FIT3175 A2 — everything is already done.",
    );
  });

  it("fixSourcePrompt names the source id and its error", () => {
    expect(fixSourcePrompt({ label: "Canvas", id: "campus-canvas", lastError: "401 Unauthorized" })).toBe(
      "Help me fix Canvas (campus-canvas): 401 Unauthorized",
    );
  });
});

describe("context-summary builders", () => {
  it("ackBriefSummary names the brief id", () => {
    expect(ackBriefSummary({ id: "brief-1", title: "Your Friday digest" })).toBe(
      'User marked the brief "Your Friday digest" (id brief-1) as read.',
    );
  });

  it("ackAllBriefsSummary pluralises correctly", () => {
    expect(ackAllBriefsSummary(1)).toBe("User marked 1 brief as read.");
    expect(ackAllBriefsSummary(3)).toBe("User marked 3 briefs as read.");
  });

  it("checklistToggleSummary matches the owner's own example shape", () => {
    const plan = { kind: "weekly", subject: "2026-W39" };
    const item = { text: "Draft intro" };
    expect(checklistToggleSummary(plan, item, true, 3, 7)).toBe(
      'User checked "Draft intro" in plan 2026-W39 (3/7 done).',
    );
    expect(checklistToggleSummary(plan, item, false, 2, 7)).toBe(
      'User unchecked "Draft intro" in plan 2026-W39 (2/7 done).',
    );
  });
});

describe("detectCapabilities", () => {
  it("reports no capabilities for a host that declares none", () => {
    expect(detectCapabilities({}, undefined)).toEqual({ message: false, updateModelContext: false });
    expect(detectCapabilities(undefined, undefined)).toEqual({ message: false, updateModelContext: false });
  });

  it("reports message support when the host declares hostCapabilities.message", () => {
    expect(detectCapabilities({ message: { text: {} } }, undefined)).toEqual({
      message: true,
      updateModelContext: false,
    });
  });

  it("reports updateModelContext support the same way", () => {
    expect(detectCapabilities({ updateModelContext: { text: {} } }, undefined)).toEqual({
      message: false,
      updateModelContext: true,
    });
  });

  it("ignores look-alike flags under experimental", () => {
    expect(detectCapabilities({ experimental: { messages: {}, updateModelContext: {} } }, undefined)).toEqual({
      message: false,
      updateModelContext: false,
    });
  });

  it("reports message support via ChatGPT's window.openai.sendFollowUpMessage even with no MCP Apps flag", () => {
    const fakeOpenAi = { sendFollowUpMessage: () => {} };
    expect(detectCapabilities({}, fakeOpenAi)).toEqual({ message: true, updateModelContext: false });
  });

  it("does not infer message support from an openai global missing the function", () => {
    expect(detectCapabilities({}, {})).toEqual({ message: false, updateModelContext: false });
  });
});
