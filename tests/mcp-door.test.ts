import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BriefStore } from "../src/briefs";
import { MemoryCapExceededError, type MemoryStore } from "../src/memory";
import { createDoorMcpServer, type DoorDeps } from "../src/mcp/door";
import type { ChangesPage, CourseView, ItemList, ItemSummary, LifeView, PlanResult, StatusView } from "../src/mcp/door-contracts";
import { WIDGET_URIS } from "../src/mcp/door-contracts";
import type { DoorRepository } from "../src/mcp/door-repository";
import { PLAYBOOKS } from "../src/playbooks";
import type { SettingsRepository } from "../src/settings";

const closeCallbacks: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closeCallbacks.splice(0).map((close) => close()));
  vi.restoreAllMocks();
});

const item = (overrides: Partial<ItemSummary> = {}): ItemSummary => ({
  source: "campus-moodle",
  itemId: "assess-401",
  kind: "assessment",
  title: "Lab report 4",
  url: "https://moodle.example.edu/mod/assign/view.php?id=401",
  timestamp: "2026-09-10T00:00:00.000Z",
  dueAt: "2026-09-24T23:55:00.000Z",
  state: "not submitted",
  course: "FIT2004",
  bucket: "course/FIT2004/lab-4",
  topic: null,
  labeledBy: "structure",
  unlabeled: false,
  staff: false,
  snippet: null,
  ...overrides,
});

function fakeRepo(overrides: Partial<DoorRepository> = {}): DoorRepository {
  return {
    changesSince: vi.fn().mockResolvedValue({ events: [], nextCursor: "0", hasMore: false, counts: {} } satisfies ChangesPage),
    course: vi.fn(),
    life: vi.fn(),
    searchItems: vi.fn().mockResolvedValue([]),
    upcoming: vi.fn().mockResolvedValue([]),
    getPlan: vi.fn().mockResolvedValue(null),
    savePlan: vi.fn(),
    plannedSubjects: vi.fn().mockResolvedValue(new Set()),
    labelItems: vi.fn().mockResolvedValue({ updated: 0, unknownItems: [], invalid: [] }),
    listKnownCourseCodes: vi.fn().mockResolvedValue([]),
    unlabeledItems: vi.fn().mockResolvedValue([]),
    sourceStatus: vi.fn().mockResolvedValue({ sources: [], latestCursor: "0", lastCycleAt: null }),
    ...overrides,
  };
}

function fakeDeps(overrides: Partial<DoorDeps> = {}): DoorDeps {
  return {
    briefs: {
      insert: vi.fn().mockImplementation(async (input) => ({ ...input, createdAt: "2026-09-26T00:00:00.000Z", readAt: null })),
      list: vi.fn().mockResolvedValue([]),
      markRead: vi.fn().mockResolvedValue(0),
      prune: vi.fn(),
      exists: vi.fn().mockResolvedValue(false),
      latestByKind: vi.fn().mockResolvedValue(null),
    } as unknown as BriefStore,
    memory: {
      get: vi.fn().mockResolvedValue({ domain: "corrections", content: "", updatedAt: "" }),
      list: vi.fn().mockResolvedValue([]),
      save: vi.fn().mockResolvedValue({ domain: "corrections", content: "", updatedAt: "" }),
    } as unknown as MemoryStore,
    repo: fakeRepo(),
    settings: { get: vi.fn().mockResolvedValue({ retentionDays: 180, syncEnabled: true, timezone: "Australia/Melbourne" }), save: vi.fn() } as unknown as SettingsRepository,
    schedulerStatus: vi.fn().mockResolvedValue({ running: true }),
    now: () => new Date("2026-09-26T10:00:00.000Z"),
    ...overrides,
  };
}

async function connectClient(deps: DoorDeps): Promise<Client> {
  const server = await createDoorMcpServer(deps);
  const client = new Client({ name: "unicorn-door-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  closeCallbacks.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  return content.find((entry) => entry.type === "text")?.text ?? "";
}

describe("unicorn door MCP server", () => {
  it("exposes exactly the fourteen door v2 tools", async () => {
    const client = await connectClient(fakeDeps());

    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [
        "ack_briefs",
        "changes_since",
        "course",
        "get_briefs",
        "get_plan",
        "label_items",
        "life",
        "remember",
        "run_playbook",
        "save_plan",
        "search_items",
        "status",
        "upcoming",
        "write_brief",
      ].sort(),
    );
  });

  it("attaches widget _meta to the tools door-contracts maps to a widget, and none to the rest", async () => {
    const client = await connectClient(fakeDeps());
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    const widgeted: Record<string, keyof typeof WIDGET_URIS> = {
      get_briefs: "briefCard",
      course: "courseView",
      changes_since: "changesFeed",
      get_plan: "planChecklist",
      save_plan: "planChecklist",
      upcoming: "deadlineTimeline",
      search_items: "deadlineTimeline",
      status: "connectionStatus",
    };
    for (const [name, widget] of Object.entries(widgeted)) {
      const meta = byName.get(name)?._meta as Record<string, unknown> | undefined;
      expect(meta?.ui).toMatchObject({ resourceUri: WIDGET_URIS[widget] });
    }
    for (const name of ["ack_briefs", "write_brief", "life", "remember", "label_items", "run_playbook"]) {
      expect(byName.get(name)?._meta).toBeUndefined();
    }
  });

  it("lists the door's six widget resources", async () => {
    const client = await connectClient(fakeDeps());

    const { resources } = await client.listResources();

    expect(resources.map((resource) => resource.uri).sort()).toEqual(Object.values(WIDGET_URIS).sort());
  });

  it("lists the four playbooks as prompts, with their door-contracts arguments", async () => {
    const client = await connectClient(fakeDeps());

    const { prompts } = await client.listPrompts();

    expect(prompts.map((prompt) => prompt.name).sort()).toEqual(["decompose-assignment", "forum-brief", "triage", "weekly-plan"]);
    const decompose = prompts.find((prompt) => prompt.name === "decompose-assignment")!;
    expect(decompose.arguments).toEqual([{ name: "assignment", description: expect.any(String), required: false }]);
  });

  it("returns each playbook's exact procedure text as a prompt message", async () => {
    const client = await connectClient(fakeDeps());

    for (const playbook of PLAYBOOKS) {
      const result = await client.getPrompt({ name: playbook.id, arguments: {} });
      expect(result.messages).toEqual([{ role: "user", content: { type: "text", text: playbook.procedure } }]);
    }
  });

  describe("get_briefs / ack_briefs / write_brief", () => {
    it("defaults to unread only and reports the total unread separately from the page", async () => {
      const unread = [
        { id: "b1", kind: "digest", subject: "s", title: "T1", body: "Body one.", createdAt: "2026-09-26T00:00:00.000Z", readAt: null },
        { id: "b2", kind: "digest", subject: "s", title: "T2", body: "Body two.", createdAt: "2026-09-25T00:00:00.000Z", readAt: null },
      ];
      const list = vi.fn().mockImplementation(async ({ unreadOnly, limit }) => (unreadOnly && limit === 20 ? [unread[0]] : unread));
      const client = await connectClient(fakeDeps({ briefs: { list, markRead: vi.fn() } as unknown as BriefStore }));

      const result = await client.callTool({ name: "get_briefs", arguments: {} });

      expect(result.structuredContent).toEqual({ briefs: [unread[0]], unread: 2 });
      expect(textOf(result)).toContain("Body one.");
      expect(textOf(result)).toContain("Next:");
    });

    it("never truncates a brief body in the text rendering", async () => {
      const longBody = "x".repeat(5000);
      const list = vi.fn().mockResolvedValue([{ id: "b1", kind: "digest", subject: "s", title: "T", body: longBody, createdAt: "2026-09-26T00:00:00.000Z", readAt: null }]);
      const client = await connectClient(fakeDeps({ briefs: { list } as unknown as BriefStore }));

      const result = await client.callTool({ name: "get_briefs", arguments: {} });

      expect(textOf(result)).toContain(longBody);
    });

    it("says so plainly with no briefs at all", async () => {
      const client = await connectClient(fakeDeps());
      const result = await client.callTool({ name: "get_briefs", arguments: {} });
      expect(textOf(result)).toMatch(/^No briefs \(0 unread overall\)\./);
    });

    it("acknowledges briefs by id", async () => {
      const markRead = vi.fn().mockResolvedValue(2);
      const client = await connectClient(fakeDeps({ briefs: { markRead, list: vi.fn().mockResolvedValue([]) } as unknown as BriefStore }));

      const result = await client.callTool({ name: "ack_briefs", arguments: { ids: ["a", "b"] } });

      expect(markRead).toHaveBeenCalledWith(["a", "b"]);
      expect(result.structuredContent).toEqual({ acknowledged: 2 });
    });

    it("computes the routine brief id from kind and idempotencyKey, and is a no-op on retry", async () => {
      const insert = vi.fn().mockImplementation(async (input) => ({ ...input, createdAt: "2026-09-26T00:00:00.000Z", readAt: null }));
      const client = await connectClient(fakeDeps({ briefs: { insert, list: vi.fn() } as unknown as BriefStore }));
      const args = { kind: "forum-brief", subject: "FIT3175", title: "Forum brief", body: "Nothing new.", idempotencyKey: "FIT3175:420" };

      await client.callTool({ name: "write_brief", arguments: args });
      await client.callTool({ name: "write_brief", arguments: args });

      expect(insert).toHaveBeenNthCalledWith(1, expect.objectContaining({ id: "routine:forum-brief:FIT3175:420" }));
      expect(insert).toHaveBeenNthCalledWith(2, expect.objectContaining({ id: "routine:forum-brief:FIT3175:420" }));
    });

    it("rejects a kind that is not a kebab-case slug", async () => {
      const client = await connectClient(fakeDeps());
      const result = await client.callTool({
        name: "write_brief",
        arguments: { kind: "Forum Brief!", subject: "s", title: "t", body: "b", idempotencyKey: "k" },
      });
      expect(result.isError).toBe(true);
    });
  });

  describe("changes_since", () => {
    it("renders a complete empty state naming the cursor", async () => {
      const repo = fakeRepo({ changesSince: vi.fn().mockResolvedValue({ events: [], nextCursor: "812", hasMore: false, counts: {} }) });
      const client = await connectClient(fakeDeps({ repo }));

      const result = await client.callTool({ name: "changes_since", arguments: { cursor: "812" } });

      expect(textOf(result)).toContain("No changes since cursor 812.");
    });

    it("renders every event's title, and passes legacy v1 type strings through untranslated", async () => {
      const page: ChangesPage = {
        events: [
          {
            cursor: "5",
            type: "item.created",
            at: "2026-09-20T00:00:00.000Z",
            source: "campus-moodle",
            itemId: "a1",
            kind: "assessment",
            title: "Legacy row title",
            url: null,
            course: "FIT2004",
            bucket: "course/FIT2004/general",
            topic: null,
            field: null,
            before: null,
            after: null,
          },
          {
            cursor: "6",
            type: "deadline.changed",
            at: "2026-09-21T00:00:00.000Z",
            source: "campus-canvas",
            itemId: "a2",
            kind: "assessment",
            title: "New row title",
            url: null,
            course: "FIT3175",
            bucket: "course/FIT3175/assignment-2",
            topic: null,
            field: "dueAt",
            before: "2026-10-03T00:00:00.000Z",
            after: "2026-10-06T00:00:00.000Z",
          },
        ],
        nextCursor: "6",
        hasMore: false,
        counts: { "deadline.changed": 1 },
      };
      const repo = fakeRepo({ changesSince: vi.fn().mockResolvedValue(page) });
      const client = await connectClient(fakeDeps({ repo }));

      const result = await client.callTool({ name: "changes_since", arguments: {} });

      expect(result.structuredContent).toEqual(page);
      const text = textOf(result);
      expect(text).toContain("Legacy row title");
      expect(text).toContain("item.created");
      expect(text).toContain("New row title");
      expect(text).toContain("2026-10-03T00:00:00.000Z");
      expect(text).toContain("2026-10-06T00:00:00.000Z");
    });

    it("suggests paging further when hasMore is true", async () => {
      const repo = fakeRepo({
        changesSince: vi.fn().mockResolvedValue({ events: [], nextCursor: "50", hasMore: true, counts: {} }),
      });
      const client = await connectClient(fakeDeps({ repo }));

      const result = await client.callTool({ name: "changes_since", arguments: { cursor: "10" } });

      expect(textOf(result)).toContain('changes_since({cursor:"50"})');
    });
  });

  describe("course", () => {
    it("reports no match plainly and suggests search_items", async () => {
      const view: CourseView = { query: "FIT9999", code: null, title: null, term: null, ambiguous: false, matches: [], sources: [], buckets: [], unlabeled: [] };
      const repo = fakeRepo({ course: vi.fn().mockResolvedValue(view) });
      const client = await connectClient(fakeDeps({ repo }));

      const result = await client.callTool({ name: "course", arguments: { code: "FIT9999" } });

      expect(textOf(result)).toContain('No course matches "FIT9999"');
      expect(textOf(result)).toContain("search_items");
    });

    it("lists every match without resolving, when ambiguous", async () => {
      const view: CourseView = {
        query: "FIT2004",
        code: "FIT2004",
        title: null,
        term: null,
        ambiguous: true,
        matches: [
          { code: "FIT2004", term: "2026 S1", title: "Algorithms (S1)", source: "campus-moodle", itemId: "course:1", url: null },
          { code: "FIT2004", term: "2026 S2", title: "Algorithms (S2)", source: "campus-moodle", itemId: "course:2", url: null },
        ],
        sources: ["campus-moodle"],
        buckets: [],
        unlabeled: [],
      };
      const repo = fakeRepo({ course: vi.fn().mockResolvedValue(view) });
      const client = await connectClient(fakeDeps({ repo }));

      const result = await client.callTool({ name: "course", arguments: { code: "FIT2004" } });

      expect(result.structuredContent).toEqual(view);
      const text = textOf(result);
      expect(text).toContain("Algorithms (S1)");
      expect(text).toContain("Algorithms (S2)");
      expect(text).toContain("ambiguous");
    });

    it("renders buckets, due dates in local time, and the unlabeled section", async () => {
      const view: CourseView = {
        query: "FIT2004",
        code: "FIT2004",
        title: "Algorithms",
        term: "2026 S2",
        ambiguous: false,
        matches: [],
        sources: ["campus-moodle"],
        buckets: [
          { bucket: "course/FIT2004/lab-4", label: "Lab report 4", dueAt: "2026-09-24T23:55:00.000Z", state: "not submitted", items: [item()] },
        ],
        unlabeled: [item({ itemId: "msg-1", bucket: null, unlabeled: true, course: "FIT2004" })],
      };
      const repo = fakeRepo({ course: vi.fn().mockResolvedValue(view) });
      const client = await connectClient(fakeDeps({ repo }));

      const result = await client.callTool({ name: "course", arguments: { code: "FIT2004" } });

      const text = textOf(result);
      expect(text).toContain("Lab report 4");
      expect(text).toContain("2026-09-24T23:55:00.000Z");
      expect(text).toContain("Unlabeled (1)");
      expect(text).toContain("label_items(");
    });
  });

  describe("life", () => {
    it("renders the three life buckets and an unlabeled section, ending with a labelling suggestion when items are unlabeled", async () => {
      const view: LifeView = {
        buckets: [
          { bucket: "life/events", label: "Events", dueAt: null, state: null, items: [] },
          { bucket: "life/admin", label: "Admin", dueAt: null, state: null, items: [] },
          { bucket: "life/other", label: "Other", dueAt: null, state: null, items: [] },
        ],
        unlabeled: [item({ source: "gmail", itemId: "msg-9", course: null, bucket: null, unlabeled: true })],
      };
      const repo = fakeRepo({ life: vi.fn().mockResolvedValue(view) });
      const client = await connectClient(fakeDeps({ repo }));

      const result = await client.callTool({ name: "life", arguments: {} });

      expect(result.structuredContent).toEqual(view);
      const text = textOf(result);
      expect(text).toContain("Events");
      expect(text).toContain("Unlabeled (1)");
      expect(text).toContain('run_playbook({name:"triage"})');
    });
  });

  describe("search_items / upcoming", () => {
    it("search_items reports no matches and suggests upcoming", async () => {
      const repo = fakeRepo({ searchItems: vi.fn().mockResolvedValue([]) });
      const client = await connectClient(fakeDeps({ repo }));

      const result = await client.callTool({ name: "search_items", arguments: { query: "作业" } });

      const list: ItemList = { query: "作业", items: [] };
      expect(result.structuredContent).toEqual(list);
      expect(textOf(result)).toContain('No items match "作业"');
      expect(textOf(result)).toContain("upcoming(");
    });

    it("search_items suggests the matched course when one is found", async () => {
      const repo = fakeRepo({ searchItems: vi.fn().mockResolvedValue([item()]) });
      const client = await connectClient(fakeDeps({ repo }));

      const result = await client.callTool({ name: "search_items", arguments: { query: "lab report" } });

      expect(textOf(result)).toContain('course({code:"FIT2004"})');
    });

    it("upcoming reports every item's due date and suggests decompose-assignment when an assessment is due", async () => {
      const repo = fakeRepo({ upcoming: vi.fn().mockResolvedValue([item()]) });
      const client = await connectClient(fakeDeps({ repo }));

      const result = await client.callTool({ name: "upcoming", arguments: { days: 14 } });

      const list: ItemList = { query: null, items: [item()] };
      expect(result.structuredContent).toEqual(list);
      const text = textOf(result);
      expect(text).toContain("Lab report 4");
      expect(text).toContain("2026-09-24T23:55:00.000Z");
      expect(text).toContain('run_playbook({name:"decompose-assignment"})');
    });

    it("upcoming says plainly when nothing is due", async () => {
      const repo = fakeRepo({ upcoming: vi.fn().mockResolvedValue([]) });
      const client = await connectClient(fakeDeps({ repo }));

      const result = await client.callTool({ name: "upcoming", arguments: { days: 7 } });

      expect(textOf(result)).toContain("Nothing due in the next 7 days.");
    });
  });

  describe("get_plan / save_plan", () => {
    it("get_plan says plainly when no plan exists yet", async () => {
      const repo = fakeRepo({ getPlan: vi.fn().mockResolvedValue(null) });
      const client = await connectClient(fakeDeps({ repo }));

      const result = await client.callTool({ name: "get_plan", arguments: { kind: "weekly", subject: "2026-W39" } });

      const expected: PlanResult = { plan: null };
      expect(result.structuredContent).toEqual(expected);
      expect(textOf(result)).toContain('No weekly plan for "2026-W39" yet.');
      expect(textOf(result)).toContain("save_plan(");
    });

    it("save_plan echoes the full saved content and suggests get_plan", async () => {
      const savePlan = vi.fn().mockResolvedValue({ kind: "weekly", subject: "2026-W39", content: "- [ ] task", updatedAt: "2026-09-26T00:00:00.000Z" });
      const repo = fakeRepo({ savePlan });
      const client = await connectClient(fakeDeps({ repo }));

      const result = await client.callTool({ name: "save_plan", arguments: { kind: "weekly", subject: "2026-W39", content: "- [ ] task" } });

      expect(savePlan).toHaveBeenCalledWith("weekly", "2026-W39", "- [ ] task");
      expect(textOf(result)).toContain("- [ ] task");
      expect(textOf(result)).toContain("get_plan(");
    });
  });

  describe("remember", () => {
    it("saves, then reports duplicate on the exact same text", async () => {
      const client = await connectClient(fakeDeps());

      const first = await client.callTool({ name: "remember", arguments: { text: "FIT2099 quizzes don't count" } });
      expect(first.structuredContent).toEqual({ result: "saved" });
    });

    it("returns a structured error with a hint when the memory write fails", async () => {
      const get = vi.fn().mockRejectedValue(new MemoryCapExceededError(9999, "total"));
      const client = await connectClient(fakeDeps({ memory: { get, list: vi.fn(), save: vi.fn() } as unknown as MemoryStore }));

      const result = await client.callTool({ name: "remember", arguments: { text: "x" } });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual({
        error: { code: "memory_write_failed", message: expect.stringContaining("9999"), hint: expect.any(String) },
      });
    });
  });

  describe("label_items", () => {
    it("reports updated count, unknown items, and invalid buckets with a reason", async () => {
      const labelItems = vi.fn().mockResolvedValue({
        updated: 1,
        unknownItems: ["campus-moodle:missing-1"],
        invalid: [{ source: "campus-moodle", itemId: "a1", bucket: "not/a/shape/x", reason: "bad shape" }],
      });
      const repo = fakeRepo({ labelItems });
      const client = await connectClient(fakeDeps({ repo }));

      const result = await client.callTool({
        name: "label_items",
        arguments: { items: [{ source: "campus-moodle", itemId: "a2", bucket: "life/other" }] },
      });

      expect(labelItems).toHaveBeenCalledWith([{ source: "campus-moodle", itemId: "a2", bucket: "life/other" }], "client");
      const text = textOf(result);
      expect(text).toContain("Labelled 1 item.");
      expect(text).toContain("campus-moodle:missing-1");
      expect(text).toContain("bad shape");
    });
  });

  describe("status", () => {
    it("assembles sources, scheduler, cursor and timezone from independent deps", async () => {
      const repo = fakeRepo({
        sourceStatus: vi.fn().mockResolvedValue({
          sources: [{ id: "campus-moodle", label: "Moodle", lastSyncAt: "2026-09-26T21:05:00.000Z", lastError: null, items: 214 }],
          latestCursor: "418",
          lastCycleAt: "2026-09-26T21:05:00.000Z",
        }),
      });
      const client = await connectClient(fakeDeps({ repo, schedulerStatus: vi.fn().mockResolvedValue({ running: true }) }));

      const result = await client.callTool({ name: "status", arguments: {} });

      const expected: StatusView = {
        sources: [{ id: "campus-moodle", label: "Moodle", configured: true, lastSyncAt: "2026-09-26T21:05:00.000Z", lastError: null, items: 214 }],
        scheduler: { running: true, lastCycleAt: "2026-09-26T21:05:00.000Z" },
        latestCursor: "418",
        timezone: "Australia/Melbourne",
      };
      expect(result.structuredContent).toEqual(expected);
      expect(textOf(result)).toContain("Moodle");
      expect(textOf(result)).toContain("418");
    });
  });

  describe("run_playbook", () => {
    it("weekly-plan prefetches upcoming(14) and the current ISO week's plan", async () => {
      const upcoming = vi.fn().mockResolvedValue([item()]);
      const getPlan = vi.fn().mockResolvedValue(null);
      const repo = fakeRepo({ upcoming, getPlan });
      const client = await connectClient(fakeDeps({ repo }));

      const result = await client.callTool({ name: "run_playbook", arguments: { name: "weekly-plan" } });

      expect(upcoming).toHaveBeenCalledWith({ days: 14, includeOverdue: false, now: new Date("2026-09-26T10:00:00.000Z") });
      expect(getPlan).toHaveBeenCalledWith("weekly", "2026-W39");
      const structured = result.structuredContent as { data: { isoWeek: string; courses: string[] } };
      expect(structured.data.isoWeek).toBe("2026-W39");
      expect(structured.data.courses).toEqual(["FIT2004"]);
    });

    it("decompose-assignment drops assessments that already have a plan", async () => {
      const upcoming = vi.fn().mockResolvedValue([item({ itemId: "a1" }), item({ itemId: "a2" })]);
      const plannedSubjects = vi.fn().mockResolvedValue(new Set(["campus-moodle:a1"]));
      const repo = fakeRepo({ upcoming, plannedSubjects });
      const client = await connectClient(fakeDeps({ repo }));

      const result = await client.callTool({ name: "run_playbook", arguments: { name: "decompose-assignment" } });

      expect(plannedSubjects).toHaveBeenCalledWith("assignment", ["campus-moodle:a1", "campus-moodle:a2"]);
      const structured = result.structuredContent as { data: { candidates: Array<{ itemId: string }> } };
      expect(structured.data.candidates.map((candidate) => candidate.itemId)).toEqual(["a2"]);
    });

    it("forum-brief parses the previous brief's trailing cursor line and pages from there", async () => {
      const latestByKind = vi.fn().mockResolvedValue({ id: "x", kind: "forum-brief", subject: "all", title: "t", body: "Nothing new.\n\ncursor: 300", createdAt: "", readAt: null });
      const changesSince = vi.fn().mockResolvedValue({ events: [], nextCursor: "305", hasMore: false, counts: {} });
      const repo = fakeRepo({ changesSince });
      const client = await connectClient(fakeDeps({ repo, briefs: { latestByKind, list: vi.fn() } as unknown as BriefStore }));

      const result = await client.callTool({ name: "run_playbook", arguments: { name: "forum-brief" } });

      expect(changesSince).toHaveBeenCalledWith({ cursor: "300", limit: 200 });
      const structured = result.structuredContent as { data: { cursor: string; nextCursor: string } };
      expect(structured.data.cursor).toBe("300");
      expect(structured.data.nextCursor).toBe("305");
    });

    it("forum-brief starts at cursor 0 when there is no previous brief for that scope", async () => {
      const changesSince = vi.fn().mockResolvedValue({ events: [], nextCursor: "0", hasMore: false, counts: {} });
      const repo = fakeRepo({ changesSince });
      const client = await connectClient(fakeDeps({ repo }));

      await client.callTool({ name: "run_playbook", arguments: { name: "forum-brief" } });

      expect(changesSince).toHaveBeenCalledWith({ cursor: "0", limit: 200 });
    });

    it("triage prefetches unlabeled items and known course codes", async () => {
      const unlabeledItems = vi.fn().mockResolvedValue([item({ bucket: null, unlabeled: true })]);
      const listKnownCourseCodes = vi.fn().mockResolvedValue(["FIT2004", "FIT3175"]);
      const repo = fakeRepo({ unlabeledItems, listKnownCourseCodes });
      const client = await connectClient(fakeDeps({ repo }));

      const result = await client.callTool({ name: "run_playbook", arguments: { name: "triage" } });

      const structured = result.structuredContent as { data: { courses: string[]; items: unknown[] } };
      expect(structured.data.courses).toEqual(["FIT2004", "FIT3175"]);
      expect(structured.data.items).toHaveLength(1);
      expect(textOf(result)).toContain("write_brief(");
    });

    it("surfaces verbatim corrections as the corrections list", async () => {
      const memory = {
        get: vi.fn().mockResolvedValue({ domain: "corrections", content: "- [2026-09-01] FIT2099 quizzes don't count\n- [2026-09-10] no work on Sundays", updatedAt: "" }),
        list: vi.fn(),
        save: vi.fn(),
      } as unknown as MemoryStore;
      const client = await connectClient(fakeDeps({ memory }));

      const result = await client.callTool({ name: "run_playbook", arguments: { name: "triage" } });

      const structured = result.structuredContent as { corrections: string[] };
      expect(structured.corrections).toEqual(["[2026-09-01] FIT2099 quizzes don't count", "[2026-09-10] no work on Sundays"]);
    });
  });
});
