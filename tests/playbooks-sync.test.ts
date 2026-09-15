import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PLAYBOOKS } from "../src/agent/playbooks";

// src/agent/playbooks.ts is generated (npm run playbooks:build) from the
// markdown files in src/agent/playbooks/*.md — see scripts/build-playbooks.mjs
// for why. This test re-parses the markdown independently and fails
// `npm run check` if someone edited the markdown without regenerating.

const PLAYBOOKS_DIR = path.resolve(__dirname, "../src/agent/playbooks");
const FILES = ["weekly-plan.md", "decompose-assignment.md", "forum-brief.md"];

function parseMarkdown(file: string) {
  const raw = readFileSync(path.join(PLAYBOOKS_DIR, file), "utf8");
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    throw new Error(`${file}: missing a leading "---" header block.`);
  }
  const [, header, body] = match;
  const fields = Object.fromEntries(
    header
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        const index = line.indexOf(":");
        return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
      }),
  );
  return { id: fields.id, title: fields.title, trigger: fields.trigger, output: fields.output, procedure: body.trim() };
}

describe("playbooks.ts sync with src/agent/playbooks/*.md", () => {
  it("has exactly the three ADR-0031 playbooks", () => {
    expect(PLAYBOOKS.map((playbook) => playbook.id).sort()).toEqual(
      ["decompose-assignment", "forum-brief", "weekly-plan"],
    );
  });

  it.each(FILES)("matches the generated entry for %s", (file) => {
    const expected = parseMarkdown(file);
    const actual = PLAYBOOKS.find((playbook) => playbook.id === expected.id);
    expect(actual, `playbooks.ts has no entry for id "${expected.id}" — run npm run playbooks:build`).toBeDefined();
    expect(actual).toEqual(expected);
  });
});
