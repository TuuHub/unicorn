import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PLAYBOOKS } from "../src/playbooks";

// src/playbooks.ts and claude-plugin/skills/*/SKILL.md are both generated
// (npm run playbooks:build) from the markdown files in playbooks/*.md — see
// scripts/build-playbooks.mjs for why. This test re-parses the markdown
// independently and fails `npm run check` if someone edited the markdown, or a
// generated file, without regenerating.

const PLAYBOOKS_DIR = path.resolve(__dirname, "../playbooks");
const SKILLS_DIR = path.resolve(__dirname, "../claude-plugin/skills");
const FILES = readdirSync(PLAYBOOKS_DIR)
  .filter((file) => file.endsWith(".md"))
  .sort();

// The door v2 tool list a playbook is allowed to call (src/mcp/door-contracts.ts).
// Anything else — list_courses, get_course_overview, list_staff_posts,
// list_upcoming, ask, get_item, list_changes, list_memory, ... — is a v1 name
// that must not leak back into the harness-executed procedures.
const DOOR_V2_TOOLS = [
  "get_briefs",
  "ack_briefs",
  "write_brief",
  "changes_since",
  "course",
  "life",
  "search_items",
  "upcoming",
  "get_plan",
  "save_plan",
  "remember",
  "run_playbook",
  "label_items",
  "status",
];

function parseArguments(lines: string[], start: number) {
  const args: { name: string; description: string; required: boolean }[] = [];
  let current: { name: string; description: string; required: boolean } | null = null;
  let i = start;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().length === 0) continue;
    if (!/^\s/.test(line)) break;
    const nameMatch = line.match(/^\s*-\s*name:\s*(.+)$/);
    if (nameMatch) {
      current = { name: nameMatch[1].trim(), description: "", required: true };
      args.push(current);
      continue;
    }
    const descMatch = line.match(/^\s*description:\s*(.+)$/);
    if (descMatch && current) {
      current.description = descMatch[1].trim();
      continue;
    }
    const requiredMatch = line.match(/^\s*required:\s*(true|false)\s*$/);
    if (requiredMatch && current) {
      current.required = requiredMatch[1] === "true";
      continue;
    }
  }
  return { args, next: i };
}

function parseMarkdown(file: string) {
  const raw = readFileSync(path.join(PLAYBOOKS_DIR, file), "utf8");
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    throw new Error(`${file}: missing a leading "---" header block.`);
  }
  const [, header, body] = match;
  const lines = header.split("\n");
  const fields: Record<string, unknown> = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim().length === 0) {
      i++;
      continue;
    }
    if (line.trim() === "arguments:") {
      const { args, next } = parseArguments(lines, i + 1);
      fields.arguments = args;
      i = next;
      continue;
    }
    const index = line.indexOf(":");
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    if (key === "arguments" && value === "[]") {
      fields.arguments = [];
    } else {
      fields[key] = value;
    }
    i++;
  }
  return {
    id: fields.id as string,
    title: fields.title as string,
    description: fields.description as string,
    trigger: fields.trigger as string,
    output: fields.output as string,
    arguments: (fields.arguments ?? []) as { name: string; description: string; required: boolean }[],
    procedure: body.trim(),
  };
}

// Pulls every `name` called as a door tool out of a procedure: backticked
// `tool_name(` / `tool_name({` calls, the way every playbook writes them.
function calledTools(procedure: string): string[] {
  const matches = procedure.matchAll(/`([a-z_]+)\(/g);
  return [...new Set([...matches].map((m) => m[1]))];
}

describe("playbooks.ts sync with playbooks/*.md", () => {
  it("has exactly the four door v2 playbooks", () => {
    expect(PLAYBOOKS.map((playbook) => playbook.id).sort()).toEqual(
      ["decompose-assignment", "forum-brief", "triage", "weekly-plan"],
    );
  });

  it.each(FILES)("matches the generated entry for %s", (file) => {
    const expected = parseMarkdown(file);
    const actual = PLAYBOOKS.find((playbook) => playbook.id === expected.id);
    expect(actual, `playbooks.ts has no entry for id "${expected.id}" — run npm run playbooks:build`).toBeDefined();
    expect(actual).toEqual(expected);
  });

  it.each(FILES)("matches the generated skill for %s", (file) => {
    const expected = parseMarkdown(file);
    const skillPath = path.join(SKILLS_DIR, expected.id, "SKILL.md");
    const raw = readFileSync(skillPath, "utf8");
    const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    expect(match, `${skillPath} is missing its frontmatter block`).not.toBeNull();
    const [, header, body] = match!;
    expect(header).toContain(`name: unicorn-${expected.id}`);
    expect(header).toContain(`description: ${expected.description}`);
    expect(body.trim()).toEqual(expected.procedure);
  });

  it.each(PLAYBOOKS.map((playbook) => [playbook.id, playbook] as const))(
    "%s only calls door v2 tools",
    (_id, playbook) => {
      const tools = calledTools(playbook.procedure);
      const unknown = tools.filter((tool) => !DOOR_V2_TOOLS.includes(tool));
      expect(unknown, `${playbook.id} calls tool(s) not in the door v2 list: ${unknown.join(", ")}`).toEqual([]);
    },
  );

  it.each(PLAYBOOKS.map((playbook) => [playbook.id, playbook] as const))(
    "%s carries the metadata the prompts/skills need",
    (_id, playbook) => {
      expect(playbook.title.length).toBeGreaterThan(0);
      expect(playbook.description.length).toBeGreaterThan(0);
      expect(playbook.trigger.length).toBeGreaterThan(0);
      expect(playbook.output.length).toBeGreaterThan(0);
      expect(playbook.procedure.length).toBeGreaterThan(0);
      for (const arg of playbook.arguments) {
        expect(arg.name.length).toBeGreaterThan(0);
        expect(arg.description.length).toBeGreaterThan(0);
      }
    },
  );

  it("decompose-assignment declares the optional assignment argument", () => {
    const playbook = PLAYBOOKS.find((p) => p.id === "decompose-assignment")!;
    expect(playbook.arguments).toEqual([
      expect.objectContaining({ name: "assignment", required: false }),
    ]);
  });

  it("forum-brief declares the optional course argument", () => {
    const playbook = PLAYBOOKS.find((p) => p.id === "forum-brief")!;
    expect(playbook.arguments).toEqual([expect.objectContaining({ name: "course", required: false })]);
  });

  it("weekly-plan and triage take no arguments", () => {
    expect(PLAYBOOKS.find((p) => p.id === "weekly-plan")!.arguments).toEqual([]);
    expect(PLAYBOOKS.find((p) => p.id === "triage")!.arguments).toEqual([]);
  });
});
