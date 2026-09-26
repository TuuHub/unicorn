// Door v2 (ADR-0035): the client-facing MCP server. unicorn does no reasoning
// itself (ADR-0034) — every tool here returns structured data plus a complete
// text rendering, so a client's own model can act on either. Text always ends
// with a deterministic "Next:" line suggesting concrete follow-up calls.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { BriefStore } from "../briefs";
import { routineBriefId } from "../briefs";
import { CORRECTIONS_DOMAIN, type CorrectionResult, recordCorrection } from "../corrections";
import { ASSESSMENT_KINDS } from "../kernel/courses";
import type { JsonValue } from "../kernel/types";
import type { MemoryStore } from "../memory";
import { PLAYBOOKS, type Playbook, type PlaybookArgument } from "../playbooks";
import { toJson } from "../plugins/source-values";
import type { SettingsRepository } from "../settings";
import {
  type Brief,
  type BriefList,
  type Bucket,
  type BucketGroup,
  type ChangeEvent,
  type ChangesPage,
  type CourseView,
  type ItemList,
  type ItemSummary,
  type LabeledBy,
  type LifeView,
  type Plan,
  type PlanResult,
  type PlaybookName,
  type PlaybookRun,
  type StatusView,
} from "./door-contracts";
import type { DoorRepository, LabelItemInput } from "./door-repository";
import { registerWidgetResources, widgetToolMeta } from "../widgets";
import { registerUserTools } from "../tools/user-tools";

const READ_ONLY = { destructiveHint: false, readOnlyHint: true } as const;
const WRITE = { destructiveHint: false, readOnlyHint: false } as const;

export interface DoorDeps {
  briefs: BriefStore;
  memory: MemoryStore;
  repo: DoorRepository;
  settings: SettingsRepository;
  schedulerStatus: () => Promise<{ running: boolean }>;
  now?: () => Date;
  // D1 handle for the ADR-0035 user-defined tools registered below. Optional
  // so existing callers/tests that don't touch D1 keep working unchanged;
  // production always supplies it (see src/index.ts).
  db?: D1Database;
}

const INSTRUCTIONS = [
  "unicorn is a memory layer: it ingests this user's courses, deadlines, submissions, staff forum posts and email into a structured store. It does not reason about them — you do, from what these tools return.",
  "Call get_briefs at the start of a session and whenever the user asks what is new; call ack_briefs for the ones you show.",
  "Use course/life/upcoming/search_items/changes_since for live data. Use get_plan/save_plan for day-by-day plans, label_items to sort new items into buckets, and remember for standing corrections.",
  "run_playbook prefetches data and returns a scheduled routine's procedure text — follow it, then write_brief and save_plan yourself; unicorn runs no model.",
  "Every result's `Next:` line lists concrete follow-up calls computed from the data — prefer those over guessing arguments.",
].join("\n");

// Async because registering ADR-0035 user tools means re-listing user_tools
// from D1 before the server starts handling requests — see the marked call
// below. Every caller already awaits somewhere in the same async function
// (src/index.ts's fetch handler, tests/mcp-door.test.ts's connectClient), so
// this stays a one-line ripple, not a redesign.
export async function createDoorMcpServer(deps: DoorDeps): Promise<McpServer> {
  const server = new McpServer({ name: "unicorn-door", version: "0.2.0" }, { instructions: INSTRUCTIONS });

  registerWidgetResources(server);

  server.registerTool(
    "get_briefs",
    {
      annotations: READ_ONLY,
      description:
        "List briefs — durable output written by write_brief, from playbooks or the scheduler (digests, weekly plans, forum summaries, triage notes). Defaults to unread only. Call at the start of a session and whenever the user asks what is new. Do not use for live course data — use course/life/upcoming for that.",
      inputSchema: {
        unreadOnly: z.boolean().optional().default(true).describe("false to also see already-read briefs."),
        limit: z.number().int().positive().max(100).optional().default(20),
      },
      _meta: widgetToolMeta("briefCard"),
    },
    async ({ unreadOnly, limit }) => {
      const [briefs, unread] = await Promise.all([
        deps.briefs.list({ unreadOnly, limit }),
        deps.briefs.list({ unreadOnly: true, limit: 10000 }),
      ]);
      const list: BriefList = { briefs, unread: unread.length };
      return toolResult(list, renderBriefList(list));
    },
  );

  server.registerTool(
    "ack_briefs",
    {
      annotations: WRITE,
      description: "Mark briefs as read by id, so get_briefs stops returning them by default. Call after showing a brief to the user. Never deletes anything.",
      inputSchema: { ids: z.array(z.string().trim().min(1)).min(1).max(100).describe("Brief ids, as returned by get_briefs.") },
    },
    async ({ ids }) => {
      const acknowledged = await deps.briefs.markRead(ids);
      const text = [`Marked ${acknowledged} of ${ids.length} brief${ids.length === 1 ? "" : "s"} as read.`, nextLine(["get_briefs({})"])].join("\n\n");
      return toolResult({ acknowledged }, text);
    },
  );

  server.registerTool(
    "write_brief",
    {
      annotations: WRITE,
      description:
        "Record a routine's finished output as a durable brief that get_briefs will surface. Idempotent on idempotencyKey — a retried call with the same key is a no-op, so always call it even when unsure if this is a repeat. Use this to file playbook output, not for ad-hoc notes (use remember for those).",
      inputSchema: {
        kind: z
          .string()
          .trim()
          .max(40)
          .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "kind must be a kebab-case slug, e.g. \"forum-brief\".")
          .describe("Kebab-case label for what wrote this, e.g. \"weekly-plan\" or \"forum-brief\"."),
        subject: z.string().trim().min(1).max(200).describe("What this brief is about, e.g. an ISO week or a course code."),
        title: z.string().trim().min(1).max(200),
        body: z.string().min(1).max(20000).describe("Markdown body, shown in full by get_briefs."),
        idempotencyKey: z.string().trim().min(1).max(200).describe("Stable across retries of the same run (e.g. the ISO week or a cursor value). A repeat is a no-op."),
      },
    },
    async ({ kind, subject, title, body, idempotencyKey }) => {
      const brief = await deps.briefs.insert({ id: routineBriefId(kind, idempotencyKey), kind, subject, title, body });
      const text = [`Filed brief [${brief.id}] "${brief.title}" (created ${brief.createdAt}).`, nextLine(["get_briefs({unreadOnly:false})"])].join("\n\n");
      return toolResult(brief, text);
    },
  );

  server.registerTool(
    "changes_since",
    {
      annotations: READ_ONLY,
      description:
        "Page through what changed since a cursor: new items, deadline/state/grade/content changes, staff notices. Omit cursor for the latest 20 changes. Pass the returned nextCursor back to page forward. Do not use for current state — use course/life/upcoming for that.",
      inputSchema: {
        cursor: z.string().trim().regex(/^\d+$/).optional().describe("The nextCursor from a previous call. Omit on the first call."),
        limit: z.number().int().positive().max(500).optional().default(100),
        course: z.string().trim().min(1).optional().describe("Unit code, e.g. \"FIT3175\", to only see that course's changes."),
        types: z.array(z.string().trim().min(1)).optional().describe("Restrict to these change types, e.g. [\"deadline.changed\",\"notice.posted\"]. Legacy type names also work."),
      },
      _meta: widgetToolMeta("changesFeed"),
    },
    async ({ cursor, limit, course, types }) => {
      const page = await deps.repo.changesSince({ cursor, limit, course, types });
      const tz = await timezoneOf(deps);
      return toolResult(page, renderChangesPage(page, tz));
    },
  );

  server.registerTool(
    "course",
    {
      annotations: READ_ONLY,
      description:
        "Get one course's assignment buckets (with due dates, submission state, staff answers) and general notices, resolved from a unit code. Returns ambiguous:true with every match when more than one offering fits — never guesses. Do not use for non-course items — use life() for those.",
      inputSchema: { code: z.string().trim().min(1).max(20).describe("A unit code, e.g. \"FIT3175\".") },
      _meta: widgetToolMeta("courseView"),
    },
    async ({ code }) => {
      const view = await deps.repo.course(code);
      const tz = await timezoneOf(deps);
      return toolResult(view, renderCourseView(view, tz));
    },
  );

  server.registerTool(
    "life",
    {
      annotations: READ_ONLY,
      description: "Get non-course items grouped into life/events, life/admin, life/other, plus anything not yet labelled. Do not use for course work — use course(code) for that.",
      inputSchema: {},
    },
    async () => {
      const view = await deps.repo.life();
      const tz = await timezoneOf(deps);
      return toolResult(view, renderLifeView(view, tz));
    },
  );

  server.registerTool(
    "search_items",
    {
      annotations: READ_ONLY,
      description:
        "Full-text search item titles and bodies across every source. Use to find a specific item by name when you don't already have its course or a due-date window. For deadlines use upcoming instead.",
      inputSchema: {
        query: z.string().trim().min(1).max(200),
        kind: z.string().trim().min(1).optional().describe("Restrict to one kind, e.g. \"assessment\" or \"thread\"."),
        course: z.string().trim().min(1).optional(),
        since: z.string().trim().min(1).optional().describe("ISO timestamp; only items at or after this."),
        limit: z.number().int().positive().max(100).optional().default(20),
      },
      _meta: widgetToolMeta("deadlineTimeline"),
    },
    async ({ query, kind, course, since, limit }) => {
      const items = await deps.repo.searchItems({ query, kind, course, since, limit });
      const tz = await timezoneOf(deps);
      const list: ItemList = { query, items };
      return toolResult(list, renderItemList(items, tz, `No items match "${query}".`, searchNextSuggestions(items, query)));
    },
  );

  server.registerTool(
    "upcoming",
    {
      annotations: READ_ONLY,
      description:
        "List items with a deadline in the next N days across every course, ordered by due date. Set includeOverdue to also see missed deadlines from the last 90 days. Use this for \"what's due\" questions rather than searching each course individually.",
      inputSchema: {
        days: z.number().int().positive().max(180).optional().default(14),
        course: z.string().trim().min(1).optional(),
        includeOverdue: z.boolean().optional().default(false),
      },
      _meta: widgetToolMeta("deadlineTimeline"),
    },
    async ({ days, course, includeOverdue }) => {
      const items = await deps.repo.upcoming({ days, course, includeOverdue });
      const tz = await timezoneOf(deps);
      const list: ItemList = { query: null, items };
      return toolResult(list, renderItemList(items, tz, `Nothing due in the next ${days} days.`, upcomingNextSuggestions(items)));
    },
  );

  server.registerTool(
    "get_plan",
    {
      annotations: READ_ONLY,
      description:
        'Read the saved plan for a week or one assignment. subject is an ISO week like "2026-W39" for kind "weekly", or exactly "<source>:<itemId>" for kind "assignment" (matching what upcoming/search_items return). A null plan means none exists yet — not an error.',
      inputSchema: { kind: z.enum(["weekly", "assignment"]), subject: z.string().trim().min(1).max(200) },
      _meta: widgetToolMeta("planChecklist"),
    },
    async ({ kind, subject }) => {
      const plan = await deps.repo.getPlan(kind, subject);
      const result: PlanResult = { plan };
      return toolResult(result, renderPlanResult(result, kind, subject));
    },
  );

  server.registerTool(
    "save_plan",
    {
      annotations: WRITE,
      description:
        "Save or overwrite the plan for a week or one assignment. Replaces the whole content — call get_plan first if you want to edit rather than replace. content is markdown; use GitHub task syntax (\"- [ ] text\") for checklist lines.",
      inputSchema: {
        kind: z.enum(["weekly", "assignment"]),
        subject: z.string().trim().min(1).max(200),
        content: z.string().min(1).max(20000),
      },
      _meta: widgetToolMeta("planChecklist"),
    },
    async ({ kind, subject, content }) => {
      const plan = await deps.repo.savePlan(kind, subject, content);
      const result: PlanResult = { plan };
      const text = [`Saved ${kind} plan for "${subject}" (updated ${plan.updatedAt}).`, plan.content, nextLine([`get_plan({kind:"${kind}", subject:"${subject}"})`])].join("\n\n");
      return toolResult(result, text);
    },
  );

  server.registerTool(
    "remember",
    {
      annotations: WRITE,
      description:
        'Save a verbatim correction or standing preference for future structured output (e.g. "FIT2099 quizzes don\'t count toward the final grade"). Stored zero-LLM, exactly as written, and surfaced back via run_playbook\'s corrections. Not for one-off facts — only durable rules.',
      inputSchema: { text: z.string().trim().min(1).max(500) },
    },
    async ({ text }) => {
      try {
        const result = await recordCorrection(deps.memory, text);
        return toolResult({ result }, renderRememberResult(result, text));
      } catch (error) {
        return errorResult("memory_write_failed", messageOf(error), "The correction was not saved. Retry remember with a shorter note, or ask the user to drop an older one first.");
      }
    },
  );

  server.registerTool(
    "label_items",
    {
      annotations: WRITE,
      description:
        'Assign items to buckets: "course/<CODE>/<assignment-slug>", "course/<CODE>/general", "life/events", "life/admin", or "life/other". Use for items course() or life() returned as unlabeled. Never guess a course for something ambiguous — leave it out of the batch instead.',
      inputSchema: {
        items: z
          .array(
            z.object({
              source: z.string().trim().min(1),
              itemId: z.string().trim().min(1),
              bucket: z.string().trim().min(1),
              topic: z.string().trim().min(1).max(40).optional(),
            }),
          )
          .min(1)
          .max(200),
        by: z.enum(["client", "triage"]).optional().default("client"),
      },
    },
    async ({ items, by }) => {
      const result = await deps.repo.labelItems(items as LabelItemInput[], by as LabeledBy);
      return toolResult(result, renderLabelItemsResult(result));
    },
  );

  server.registerTool(
    "status",
    {
      annotations: READ_ONLY,
      description: "Report each source's last sync time and error, whether the scheduler is running, the latest changes_since cursor, and the configured timezone. Use to explain stale or missing data.",
      inputSchema: {},
      _meta: widgetToolMeta("connectionStatus"),
    },
    async () => {
      const [repoStatus, scheduler, settings] = await Promise.all([deps.repo.sourceStatus(), deps.schedulerStatus(), deps.settings.get()]);
      const view: StatusView = {
        sources: repoStatus.sources.map((source) => ({
          id: source.id,
          label: source.label,
          configured: true,
          lastSyncAt: source.lastSyncAt,
          lastError: source.lastError,
          items: source.items,
        })),
        scheduler: { running: scheduler.running, lastCycleAt: repoStatus.lastCycleAt },
        latestCursor: repoStatus.latestCursor,
        timezone: settings.timezone,
      };
      return toolResult(view, renderStatusView(view));
    },
  );

  server.registerTool(
    "run_playbook",
    {
      annotations: READ_ONLY,
      description:
        "Fetch a scheduled routine's procedure text plus the data it needs, already queried. Follow the returned instructions yourself, then call write_brief/save_plan/label_items as the procedure says — unicorn runs no model and takes no further action on its own. Use when the user asks to run a routine (weekly-plan, decompose-assignment, forum-brief, triage) now.",
      inputSchema: { name: z.enum(["weekly-plan", "decompose-assignment", "forum-brief", "triage"]) },
    },
    async ({ name }) => {
      const playbook = PLAYBOOKS.find((candidate) => candidate.id === name);
      if (!playbook) {
        return errorResult("unknown_playbook", `No playbook named "${name}".`, "Call prompts/list, or use one of: weekly-plan, decompose-assignment, forum-brief, triage.");
      }
      const now = deps.now ? deps.now() : new Date();
      const data = await playbookData(name, deps.repo, deps.briefs, now);
      const corrections = await correctionLines(deps.memory);
      const run: PlaybookRun = { name, instructions: playbook.procedure, data, corrections };
      return toolResult(run, renderPlaybookRun(run, playbook));
    },
  );

  for (const playbook of PLAYBOOKS) {
    server.registerPrompt(
      playbook.id,
      { title: playbook.title, description: playbook.description, argsSchema: promptArgsShape(playbook) },
      async () => ({
        messages: [{ role: "user" as const, content: { type: "text" as const, text: playbook.procedure } }],
      }),
    );
  }

  // user-defined tools (ADR-0035) are registered here
  if (deps.db) {
    await registerUserTools(server, { db: deps.db });
  }

  return server;
}

// --- shared result/error helpers --------------------------------------------

function toolResult(structuredContent: unknown, text: string) {
  return { content: [{ type: "text" as const, text }], structuredContent: structuredContent as Record<string, unknown> };
}

function errorResult(code: string, message: string, hint: string) {
  return {
    content: [{ type: "text" as const, text: `Error (${code}): ${message}\nNext: ${hint}` }],
    structuredContent: { error: { code, message, hint } },
    isError: true,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nextLine(suggestions: string[]): string {
  return `Next: ${suggestions.join(" · ")}`;
}

async function timezoneOf(deps: DoorDeps): Promise<string> {
  return (await deps.settings.get()).timezone;
}

function withLocal(iso: string | null, tz: string): string {
  if (!iso) {
    return "none";
  }
  try {
    const local = new Intl.DateTimeFormat("en-AU", { timeZone: tz, dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
    return `${iso} (${local})`;
  } catch {
    return iso;
  }
}

// --- item / bucket rendering -------------------------------------------------

function itemLine(item: ItemSummary, tz: string): string {
  const bits = [`[${item.source}:${item.itemId}] ${item.title}`];
  if (item.dueAt) {
    bits.push(`due ${withLocal(item.dueAt, tz)}`);
  }
  if (item.state) {
    bits.push(`state: ${item.state}`);
  }
  if (item.bucket) {
    bits.push(item.bucket);
  } else if (item.unlabeled) {
    bits.push("unlabeled");
  }
  if (item.staff) {
    bits.push("staff");
  }
  if (item.url) {
    bits.push(item.url);
  }
  const line = `- ${bits.join(" — ")}`;
  return item.snippet ? `${line}\n  ${item.snippet}` : line;
}

function renderItemList(items: ItemSummary[], tz: string, emptyMessage: string, next: string[]): string {
  const lines: string[] = [];
  if (items.length === 0) {
    lines.push(emptyMessage);
  } else {
    lines.push(`${items.length} item${items.length === 1 ? "" : "s"}:`);
    for (const item of items) {
      lines.push(itemLine(item, tz));
    }
  }
  lines.push(nextLine(next));
  return lines.join("\n");
}

function searchNextSuggestions(items: ItemSummary[], query: string): string[] {
  const course = items.find((item) => item.course)?.course;
  if (course) {
    return [`course({code:"${course}"})`];
  }
  return items.length === 0 ? [`upcoming({days:14})`] : [`upcoming({days:14})`];
}

function upcomingNextSuggestions(items: ItemSummary[]): string[] {
  if (items.length === 0) {
    return [`upcoming({days:30})`];
  }
  const due = items.find((item) => item.kind && ASSESSMENT_KINDS.has(item.kind));
  return due ? [`run_playbook({name:"decompose-assignment"})`, `course({code:"${due.course ?? ""}"})`].filter((s) => !s.includes('""')) : [`course({code:"${items[0]!.course ?? ""}"})`];
}

function renderBucketGroup(group: BucketGroup, tz: string): string[] {
  const header = [`## ${group.label}`];
  if (group.dueAt) {
    header.push(`due ${withLocal(group.dueAt, tz)}`);
  }
  if (group.state) {
    header.push(`(${group.state})`);
  }
  const lines = [header.join(" — ")];
  if (group.items.length === 0) {
    lines.push("Nothing here.");
  } else {
    for (const item of group.items) {
      lines.push(itemLine(item, tz));
    }
  }
  return lines;
}

function renderCourseView(view: CourseView, tz: string): string {
  if (!view.code && !view.ambiguous) {
    return [`No course matches "${view.query}".`, nextLine([`search_items({query:"${view.query}"})`])].join("\n");
  }
  if (view.ambiguous) {
    const lines = [`"${view.query}" is ambiguous — ${view.matches.length} offerings matched, none resolved as current:`];
    for (const match of view.matches) {
      lines.push(`- [${match.source}:${match.itemId}] ${match.title}${match.term ? ` (${match.term})` : ""}`);
    }
    lines.push(nextLine([`search_items({query:"${view.code ?? view.query}"})`]));
    return lines.join("\n");
  }
  const lines = [`# ${view.code}${view.term ? ` (${view.term})` : ""} — ${view.title}`, `Sources: ${view.sources.join(", ")}`];
  if (view.buckets.length === 0) {
    lines.push("No labelled items yet.");
  }
  for (const group of view.buckets) {
    lines.push(...renderBucketGroup(group, tz));
  }
  if (view.unlabeled.length > 0) {
    lines.push(`## Unlabeled (${view.unlabeled.length})`);
    for (const item of view.unlabeled) {
      lines.push(itemLine(item, tz));
    }
  }
  const next = [`upcoming({course:"${view.code}"})`];
  if (view.unlabeled.length > 0) {
    next.push(`label_items({items:[{source:"...", itemId:"...", bucket:"course/${view.code}/general"}]})`);
  }
  lines.push(nextLine(next));
  return lines.join("\n");
}

function renderLifeView(view: LifeView, tz: string): string {
  const lines = ["# Life"];
  for (const group of view.buckets) {
    lines.push(...renderBucketGroup(group, tz));
  }
  if (view.unlabeled.length > 0) {
    lines.push(`## Unlabeled (${view.unlabeled.length})`);
    for (const item of view.unlabeled) {
      lines.push(itemLine(item, tz));
    }
  }
  const next = view.unlabeled.length > 0 ? [`run_playbook({name:"triage"})`, `label_items({items:[...]})`] : [`changes_since({})`];
  lines.push(nextLine(next));
  return lines.join("\n");
}

// --- changes_since rendering -------------------------------------------------

function changeLine(event: ChangeEvent, tz: string): string {
  const bits = [`[${event.source}:${event.itemId}] ${event.type}: ${event.title}`];
  if (event.course) {
    bits.push(event.course);
  }
  bits.push(withLocal(event.at, tz));
  if (event.field) {
    bits.push(`field: ${event.field}`);
  }
  if (event.url) {
    bits.push(event.url);
  }
  let line = `- ${bits.join(" — ")}`;
  if (event.before !== null || event.after !== null) {
    line += `\n  before: ${JSON.stringify(event.before)} → after: ${JSON.stringify(event.after)}`;
  }
  return line;
}

function renderChangesPage(page: ChangesPage, tz: string): string {
  const lines: string[] = [];
  if (page.events.length === 0) {
    lines.push(`No changes since cursor ${page.nextCursor}.`);
  } else {
    lines.push(`${page.events.length} change${page.events.length === 1 ? "" : "s"} up to cursor ${page.nextCursor}:`);
    for (const event of page.events) {
      lines.push(changeLine(event, tz));
    }
  }
  const next: string[] = [];
  if (page.hasMore) {
    next.push(`changes_since({cursor:"${page.nextCursor}"})`);
  } else {
    const course = page.events.find((event) => event.course)?.course;
    next.push(course ? `course({code:"${course}"})` : `get_briefs({})`);
  }
  lines.push(nextLine(next));
  return lines.join("\n");
}

// --- briefs rendering ---------------------------------------------------------

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

function renderBriefLine(brief: Brief): string {
  const status = brief.readAt ? `read ${brief.readAt}` : "unread";
  return `- [${brief.id}] ${brief.title} (${brief.kind}/${brief.subject}, ${status}, created ${brief.createdAt})\n${indent(brief.body)}`;
}

function renderBriefList(list: BriefList): string {
  if (list.briefs.length === 0) {
    return [`No briefs (${list.unread} unread overall).`, nextLine([`run_playbook({name:"triage"})`])].join("\n");
  }
  const lines = [`${list.briefs.length} brief${list.briefs.length === 1 ? "" : "s"} shown (${list.unread} unread overall):`];
  for (const brief of list.briefs) {
    lines.push(renderBriefLine(brief));
  }
  lines.push(nextLine([`ack_briefs({ids:["${list.briefs[0]!.id}"]})`]));
  return lines.join("\n");
}

function renderRememberResult(result: CorrectionResult, text: string): string {
  const line = { saved: `Saved: "${text}"`, duplicate: `Already remembered: "${text}"`, empty: "Nothing to remember — text was empty." }[result];
  return [line, nextLine([`get_briefs({})`])].join("\n");
}

// --- plan rendering -----------------------------------------------------------

function renderPlanResult(result: PlanResult, kind: string, subject: string): string {
  if (!result.plan) {
    return [`No ${kind} plan for "${subject}" yet.`, nextLine([`save_plan({kind:"${kind}", subject:"${subject}", content:"..."})`])].join("\n");
  }
  return [`# ${kind} plan — ${subject} (updated ${result.plan.updatedAt})`, result.plan.content, nextLine([`save_plan({kind:"${kind}", subject:"${subject}", content:"..."})`])].join("\n\n");
}

// --- label_items rendering -----------------------------------------------------

function renderLabelItemsResult(result: { updated: number; unknownItems: string[]; invalid: Array<{ source: string; itemId: string; bucket: string; reason: string }> }): string {
  const lines = [`Labelled ${result.updated} item${result.updated === 1 ? "" : "s"}.`];
  if (result.unknownItems.length > 0) {
    lines.push(`Unknown (not found): ${result.unknownItems.join(", ")}`);
  }
  for (const item of result.invalid) {
    lines.push(`Invalid bucket "${item.bucket}" for [${item.source}:${item.itemId}]: ${item.reason}`);
  }
  lines.push(nextLine([`life()`, `changes_since({})`]));
  return lines.join("\n");
}

// --- status rendering ----------------------------------------------------------

function renderStatusView(view: StatusView): string {
  const lines = ["# Status"];
  if (view.sources.length === 0) {
    lines.push("No sources have synced yet.");
  }
  for (const source of view.sources) {
    const bits = [`${source.label} (${source.id})`, `${source.items} item${source.items === 1 ? "" : "s"}`];
    if (source.lastSyncAt) {
      bits.push(`last sync ${source.lastSyncAt}`);
    }
    if (source.lastError) {
      bits.push(`error: ${source.lastError}`);
    }
    lines.push(`- ${bits.join(" — ")}`);
  }
  lines.push(`Scheduler: ${view.scheduler.running ? "running" : "stopped"}${view.scheduler.lastCycleAt ? `, last cycle ${view.scheduler.lastCycleAt}` : ""}.`);
  lines.push(`Latest cursor: ${view.latestCursor}. Timezone: ${view.timezone}.`);
  lines.push(nextLine([`changes_since({})`]));
  return lines.join("\n");
}

// --- run_playbook ----------------------------------------------------------

function isoWeekOf(date: Date): string {
  const truncated = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNumber = truncated.getUTCDay() || 7;
  truncated.setUTCDate(truncated.getUTCDate() + 4 - dayNumber);
  const yearStart = new Date(Date.UTC(truncated.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((truncated.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${truncated.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function subjectOf(item: ItemSummary): string {
  return `${item.source}:${item.itemId}`;
}

// The forum-brief's cursor lives in its previous brief body, on a trailing
// machine line `cursor: <n>` (see playbooks/forum-brief.md step 9) — never a
// separate table, so a fresh unicorn deploy needs no migration to keep paging.
function parseTrailingCursor(body: string | undefined | null): string | null {
  const match = body?.match(/cursor:\s*(\d+)\s*$/m);
  return match ? match[1]! : null;
}

async function correctionLines(memory: MemoryStore): Promise<string[]> {
  const note = await memory.get(CORRECTIONS_DOMAIN);
  return note.content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^-\s*/, ""));
}

async function playbookData(name: PlaybookName, repo: DoorRepository, briefs: BriefStore, now: Date): Promise<Record<string, JsonValue>> {
  const record = (value: Record<string, unknown>): Record<string, JsonValue> => toJson(value) as Record<string, JsonValue>;
  switch (name) {
    case "weekly-plan": {
      const isoWeek = isoWeekOf(now);
      const [items, plan] = await Promise.all([repo.upcoming({ days: 14, includeOverdue: false }), repo.getPlan("weekly", isoWeek)]);
      const courses = [...new Set(items.map((item) => item.course).filter((code): code is string => code !== null))].sort();
      return record({ isoWeek, upcoming: items, courses, plan });
    }
    case "decompose-assignment": {
      const items = (await repo.upcoming({ days: 21, includeOverdue: false })).filter((item) => ASSESSMENT_KINDS.has(item.kind));
      const planned = await repo.plannedSubjects("assignment", items.map(subjectOf));
      const candidates = items.filter((item) => !planned.has(subjectOf(item)));
      return record({ candidates });
    }
    case "forum-brief": {
      const latest = await briefs.latestByKind("forum-brief");
      const cursor = parseTrailingCursor(latest?.body) ?? "0";
      const page = await repo.changesSince({ cursor, limit: 200 });
      return record({ cursor, events: page.events, nextCursor: page.nextCursor, hasMore: page.hasMore });
    }
    case "triage": {
      const [items, courses] = await Promise.all([repo.unlabeledItems(100), repo.listKnownCourseCodes()]);
      return record({
        items,
        courses,
        bucketShapes: ["course/<CODE>/<assignment-slug>", "course/<CODE>/general", "life/events", "life/admin", "life/other"],
      });
    }
  }
}

function renderPlaybookRun(run: PlaybookRun, playbook: Playbook): string {
  const lines = [`# Playbook: ${playbook.title}`, playbook.procedure, "## Prefetched data", "```json", JSON.stringify(run.data, null, 2), "```"];
  lines.push(run.corrections.length > 0 ? `## Corrections\n${run.corrections.map((line) => `- ${line}`).join("\n")}` : "No corrections recorded.");
  lines.push(nextLine([`write_brief({kind:"${run.name}", subject:"...", title:"...", body:"...", idempotencyKey:"..."})`, `save_plan({kind:"weekly", subject:"...", content:"..."})`]));
  return lines.join("\n\n");
}

// --- prompts (ADR-0035): the same four playbooks, as MCP prompts ---------------

function promptArgsShape(playbook: Playbook): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const argument of playbook.arguments) {
    shape[argument.name] = promptArgSchema(argument);
  }
  return shape;
}

function promptArgSchema(argument: PlaybookArgument): z.ZodTypeAny {
  // .describe() must come after .optional(): it attaches metadata to the
  // exact schema instance, and the SDK reads it off the outermost one when
  // building prompts/list's PromptArgument[].
  return argument.required ? z.string().describe(argument.description) : z.string().optional().describe(argument.description);
}
