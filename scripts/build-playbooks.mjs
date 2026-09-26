#!/usr/bin/env node
// Regenerates src/playbooks.ts and the Claude Code plugin skills from the
// markdown sources in playbooks/*.md.
//
// Why this exists: Workers cannot import .md at runtime here because
// wrangler.jsonc has no `rules: [{ type: "Text" }]` entry. The markdown stays
// the human-edited source of truth for both the door's MCP prompts/run_playbook
// and the Claude Code plugin's skills; this script compiles it into a plain TS
// module of string constants (bundles like any other module) and into one
// SKILL.md per playbook. tests/playbooks-sync.test.ts re-parses the markdown
// independently and fails `npm run check` if either output has drifted, so a
// forgotten `npm run playbooks:build` is caught in CI rather than silently
// shipping a stale prompt or skill.
//
// Run after editing any file in playbooks/:
//   npm run playbooks:build

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const playbooksDir = path.join(root, "playbooks");
const outFile = path.join(root, "src/playbooks.ts");
const skillsDir = path.join(root, "claude-plugin/skills");

// The door v2 contract (src/mcp/door-contracts.ts PlaybookName). A playbook
// whose id is not in this list is almost certainly a typo, not a new tool.
const KNOWN_IDS = ["weekly-plan", "decompose-assignment", "forum-brief", "triage"];

function parseHeaderFields(header, file) {
  const lines = header.split("\n");
  const fields = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim().length === 0) {
      i++;
      continue;
    }
    if (/^\S+:\s*$/.test(line) && line.trim() === "arguments:") {
      const { args, next } = parseArguments(lines, i + 1, file);
      fields.arguments = args;
      i = next;
      continue;
    }
    const index = line.indexOf(":");
    if (index < 0) {
      throw new Error(`${file}: malformed header line "${line}".`);
    }
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    if (key === "arguments" && value === "[]") {
      fields.arguments = [];
    } else {
      fields[key] = value;
    }
    i++;
  }
  return fields;
}

// Parses a YAML-ish list of the shape:
//   arguments:
//     - name: assignment
//       description: ...
//       required: false
// starting right after the "arguments:" line. Stops at the first line that
// isn't indented (back to column 0), which ends the header's arguments block.
function parseArguments(lines, start, file) {
  const args = [];
  let current = null;
  let i = start;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().length === 0) continue;
    if (!/^\s/.test(line)) break; // dedent back to top level: block is over
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
    throw new Error(`${file}: malformed "arguments" entry at line "${line}".`);
  }
  return { args, next: i };
}

function parsePlaybook(raw, file) {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    throw new Error(`${file}: missing a leading "---" header block.`);
  }
  const [, header, body] = match;
  const fields = parseHeaderFields(header, file);
  for (const key of ["id", "title", "description", "trigger", "output"]) {
    if (!fields[key]) {
      throw new Error(`${file}: header is missing "${key}".`);
    }
  }
  if (!KNOWN_IDS.includes(fields.id)) {
    throw new Error(
      `${file}: id "${fields.id}" is not one of the door v2 playbooks (${KNOWN_IDS.join(", ")}).`,
    );
  }
  return {
    id: fields.id,
    title: fields.title,
    description: fields.description,
    trigger: fields.trigger,
    output: fields.output,
    arguments: fields.arguments ?? [],
    procedure: body.trim(),
  };
}

function escapeTemplate(text) {
  return text.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}

function renderArgumentsLiteral(args) {
  if (args.length === 0) return "[]";
  const items = args
    .map(
      (arg) =>
        `{ name: ${JSON.stringify(arg.name)}, description: ${JSON.stringify(arg.description)}, required: ${arg.required} }`,
    )
    .join(", ");
  return `[${items}]`;
}

function writePlaybooksModule(playbooks) {
  const entries = playbooks
    .map(
      (playbook) => `  {
    id: ${JSON.stringify(playbook.id)},
    title: ${JSON.stringify(playbook.title)},
    description: ${JSON.stringify(playbook.description)},
    trigger: ${JSON.stringify(playbook.trigger)},
    output: ${JSON.stringify(playbook.output)},
    arguments: ${renderArgumentsLiteral(playbook.arguments)},
    procedure: \`${escapeTemplate(playbook.procedure)}\`,
  },`,
    )
    .join("\n");

  const output = `// AUTO-GENERATED by scripts/build-playbooks.mjs from playbooks/*.md.
// Do not edit by hand — edit the markdown, then run \`npm run playbooks:build\`.
// tests/playbooks-sync.test.ts fails \`npm run check\` if this drifts from the markdown.

import type { PlaybookName } from "./mcp/door-contracts";

// Identical to PlaybookName; kept as its own alias so this module has no other
// dependency on the door contracts than the one type it must never drift from.
export type PlaybookId = PlaybookName;

export interface PlaybookArgument {
  name: string;
  description: string;
  required: boolean;
}

export interface Playbook {
  id: PlaybookId;
  title: string;
  description: string;
  trigger: string;
  output: string;
  arguments: PlaybookArgument[];
  procedure: string;
}

export const PLAYBOOKS: Playbook[] = [
${entries}
];
`;

  writeFileSync(outFile, output);
}

function skillFrontmatterName(id) {
  return `unicorn-${id}`;
}

function writeSkillFiles(playbooks) {
  for (const playbook of playbooks) {
    const dir = path.join(skillsDir, playbook.id);
    mkdirSync(dir, { recursive: true });
    const frontmatter = [
      "---",
      `name: ${skillFrontmatterName(playbook.id)}`,
      `description: ${playbook.description}`,
      "---",
      "",
    ].join("\n");
    // The skill body IS the playbook procedure: one source of truth for what
    // the model does whether it's driven by run_playbook or by this skill.
    const body = `${playbook.procedure}\n`;
    writeFileSync(path.join(dir, "SKILL.md"), frontmatter + body);
  }
}

function main() {
  const files = readdirSync(playbooksDir)
    .filter((file) => file.endsWith(".md"))
    .sort();
  if (files.length === 0) {
    throw new Error(`No markdown playbooks found in ${playbooksDir}.`);
  }
  const playbooks = files.map((file) => parsePlaybook(readFileSync(path.join(playbooksDir, file), "utf8"), file));

  const seen = new Set();
  for (const playbook of playbooks) {
    if (seen.has(playbook.id)) {
      throw new Error(`Duplicate playbook id "${playbook.id}".`);
    }
    seen.add(playbook.id);
  }

  writePlaybooksModule(playbooks);
  writeSkillFiles(playbooks);
  console.log(
    `Wrote ${path.relative(root, outFile)} and ${playbooks.length} skill(s) under ${path.relative(root, skillsDir)}/ from ${files.length} playbook(s).`,
  );
}

main();
