import {
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
  type Message,
} from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MAX_TURNS,
  DEFAULT_TIMEOUT_MS,
  PiResidentAgent,
  ResidentAgentError,
  type AgentConversationStore,
  type AgentTurnCommit,
  type AgentTurnResult,
} from "../src/agent/resident-agent";
import type { PiModelRuntime } from "../src/agent/pi-model";
import { PLAYBOOKS } from "../src/agent/playbooks";
import { buildConversationSystemPrompt } from "../src/agent/prompt";
import type { JobRunInput, JobStore } from "../src/jobs/daily-digest";
import type { AgentToolRepository } from "../src/agent/tools";

class MemoryConversationStore implements AgentConversationStore {
  readonly messages = new Map<string, Message[]>();
  readonly results = new Map<string, AgentTurnResult>();
  readonly runs: JobRunInput[] = [];

  loadMessages(conversationId: string): Promise<Message[]> {
    return Promise.resolve(this.messages.get(conversationId) ?? []);
  }

  getTurnResult(conversationId: string, idempotencyKey: string): Promise<AgentTurnResult | null> {
    return Promise.resolve(this.results.get(`${conversationId}\0${idempotencyKey}`) ?? null);
  }

  commitTurn(input: AgentTurnCommit): Promise<void> {
    this.messages.set(input.conversationId, [
      ...(this.messages.get(input.conversationId) ?? []),
      ...input.messages,
    ]);
    if (input.idempotencyKey) {
      this.results.set(`${input.conversationId}\0${input.idempotencyKey}`, input.result);
    }
    this.runs.push(input.run);
    return Promise.resolve();
  }

  reset(conversationId: string): Promise<void> {
    this.messages.delete(conversationId);
    for (const key of this.results.keys()) {
      if (key.startsWith(`${conversationId}\0`)) {
        this.results.delete(key);
      }
    }
    return Promise.resolve();
  }
}

function enabledJobStore(currentMonthUsage = 0) {
  const runs: JobRunInput[] = [];
  const store = {
    get: vi.fn().mockResolvedValue({
      id: "resident-agent",
      enabled: true,
      model: "faux-1",
      monthlyTokenCap: 10_000,
      scheduleHourUtc: 0,
      credentialPreference: "byok",
      currentMonthUsage,
      projectedMonthlyTokens: currentMonthUsage,
      lastRunAt: null,
    }),
    recordRun: vi.fn(async (run: JobRunInput) => {
      runs.push(run);
    }),
  } as unknown as JobStore;
  return { store, runs };
}

function fauxRuntime(
  responses: Parameters<ReturnType<typeof createFauxCore>["setResponses"]>[0],
  options: Parameters<typeof createFauxCore>[0] = {},
) {
  const faux = createFauxCore(options);
  faux.setResponses(responses);
  const runtime: PiModelRuntime = {
    resolve: () => ({ model: faux.getModel(), stream: faux.streamSimple }) as ReturnType<PiModelRuntime["resolve"]>,
  };
  return { faux, runtime };
}

function repository(overrides: Partial<AgentToolRepository> = {}): AgentToolRepository {
  return {
    listCourses: vi.fn().mockResolvedValue([]),
    getCourseOverview: vi.fn().mockResolvedValue({
      query: "",
      identity: null,
      assessments: [],
      staffPosts: [],
      emailMentions: [],
      sources: { moodle: false, ed: false, ontrack: false, email: false },
    }),
    searchItems: vi.fn().mockResolvedValue([]),
    find: vi.fn().mockResolvedValue(null),
    listUpcoming: vi.fn().mockResolvedValue([]),
    listEvents: vi.fn().mockResolvedValue([]),
    listStaffPosts: vi.fn().mockResolvedValue([]),
    listMemory: vi.fn().mockResolvedValue([]),
    getSyncStatus: vi.fn().mockResolvedValue(null),
    getPlan: vi.fn().mockResolvedValue(null),
    savePlan: vi.fn().mockResolvedValue({
      id: "plan-1",
      kind: "weekly",
      subject: "2026-W38",
      content: "",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }),
    remember: vi.fn().mockResolvedValue("saved"),
    ...overrides,
  };
}

describe("PiResidentAgent", () => {
  it("persists history so a follow-up turn sees the earlier conversation", async () => {
    const conversations = new MemoryConversationStore();
    const { store } = enabledJobStore();
    const seenContexts: string[] = [];
    const { runtime } = fauxRuntime([
      fauxAssistantMessage("Your FIT2099 assignment is due Monday."),
      (context) => {
        seenContexts.push(JSON.stringify(context.messages));
        return fauxAssistantMessage("It is the FIT2099 assignment.");
      },
    ]);
    const agent = new PiResidentAgent({ conversations, jobs: store, repository: repository(), runtime });

    await agent.run({ conversationId: "operator", message: "What is due Monday?" });
    const result = await agent.run({ conversationId: "operator", message: "Which course is that?" });

    expect(result.answer).toBe("It is the FIT2099 assignment.");
    expect(seenContexts[0]).toContain("What is due Monday?");
    expect(seenContexts[0]).toContain("Your FIT2099 assignment is due Monday.");
  });

  it("runs read-only Unicorn tools and answers from their result", async () => {
    const conversations = new MemoryConversationStore();
    const { store } = enabledJobStore();
    const listUpcoming = vi.fn().mockResolvedValue([
      {
        source: "campus-moodle",
        itemId: "assessment:99",
        title: "Assignment 3",
        dueAt: "2026-08-10T06:00:00.000Z",
        facetType: "deadline",
        capability: "has-deadline",
      },
    ]);
    const { runtime } = fauxRuntime([
      fauxAssistantMessage(fauxToolCall("list_upcoming", { days: 7, includeOverdue: false, limit: 10 }), {
        stopReason: "toolUse",
      }),
      (context) => {
        expect(JSON.stringify(context.messages)).toContain("Assignment 3");
        return fauxAssistantMessage("Assignment 3 is due tomorrow.");
      },
    ]);
    const agent = new PiResidentAgent({
      conversations,
      jobs: store,
      repository: repository({ listUpcoming }),
      runtime,
    });

    const result = await agent.run({ conversationId: "operator", message: "What is due this week?" });

    expect(result.answer).toBe("Assignment 3 is due tomorrow.");
    expect(result.toolsUsed).toEqual(["list_upcoming"]);
    expect(listUpcoming).toHaveBeenCalledWith({ days: 7, includeOverdue: false, limit: 10 });
  });

  it("replays an idempotent result without a second model call or duplicate messages", async () => {
    const conversations = new MemoryConversationStore();
    const { store } = enabledJobStore();
    const { faux, runtime } = fauxRuntime([fauxAssistantMessage("One answer.")]);
    const agent = new PiResidentAgent({ conversations, jobs: store, repository: repository(), runtime });
    const turn = { conversationId: "operator", message: "Hello", idempotencyKey: "request-1" };

    const first = await agent.run(turn);
    const second = await agent.run(turn);

    expect(second).toEqual(first);
    expect(faux.state.callCount).toBe(1);
    expect(conversations.messages.get("operator")).toHaveLength(2);
    expect(conversations.runs).toHaveLength(1);
  });

  it("surfaces provider failure without persisting the failed turn", async () => {
    const conversations = new MemoryConversationStore();
    const { store, runs } = enabledJobStore();
    const { runtime } = fauxRuntime([
      fauxAssistantMessage([], { stopReason: "error", errorMessage: "provider unavailable" }),
    ]);
    const agent = new PiResidentAgent({ conversations, jobs: store, repository: repository(), runtime });

    await expect(agent.run({ conversationId: "operator", message: "Hello" })).rejects.toMatchObject({
      code: "provider_failed",
    } satisfies Partial<ResidentAgentError>);
    expect(conversations.messages.has("operator")).toBe(false);
    expect(runs).toEqual([expect.objectContaining({ jobId: "resident-agent", status: "failed" })]);
  });

  it("rejects a turn before inference when the monthly budget is exhausted", async () => {
    const conversations = new MemoryConversationStore();
    const { store } = enabledJobStore(10_000);
    const { faux, runtime } = fauxRuntime([fauxAssistantMessage("must not run")]);
    const agent = new PiResidentAgent({ conversations, jobs: store, repository: repository(), runtime });

    await expect(agent.run({ conversationId: "operator", message: "Hello" })).rejects.toMatchObject({
      code: "budget_exhausted",
    } satisfies Partial<ResidentAgentError>);
    expect(faux.state.callCount).toBe(0);
  });

  it("aborts a slow provider at the turn timeout without persisting messages", async () => {
    const conversations = new MemoryConversationStore();
    const { store } = enabledJobStore();
    const { runtime } = fauxRuntime([fauxAssistantMessage("This response is intentionally slow.")], {
      tokensPerSecond: 1_000,
    });
    const agent = new PiResidentAgent({
      conversations,
      jobs: store,
      repository: repository(),
      runtime,
      timeoutMs: 1,
    });

    await expect(agent.run({ conversationId: "operator", message: "Hello" })).rejects.toMatchObject({
      code: "timed_out",
    } satisfies Partial<ResidentAgentError>);
    expect(conversations.messages.has("operator")).toBe(false);
  });

  it("fails explicitly when the tool loop reaches its turn cap", async () => {
    const conversations = new MemoryConversationStore();
    const { store } = enabledJobStore();
    const { runtime } = fauxRuntime([
      fauxAssistantMessage(fauxToolCall("list_upcoming", { days: 7 }), { stopReason: "toolUse" }),
    ]);
    const agent = new PiResidentAgent({
      conversations,
      jobs: store,
      repository: repository(),
      runtime,
      maxTurns: 1,
    });

    await expect(agent.run({ conversationId: "operator", message: "Keep looking" })).rejects.toMatchObject({
      code: "loop_exhausted",
    } satisfies Partial<ResidentAgentError>);
    expect(conversations.messages.has("operator")).toBe(false);
  });

  it("runs get_course_overview and answers from the projected result", async () => {
    const conversations = new MemoryConversationStore();
    const { store } = enabledJobStore();
    const getCourseOverview = vi.fn().mockResolvedValue({
      query: "FIT2004",
      identity: { code: "FIT2004", name: "Algorithms and Data Structures", platforms: ["campus-moodle"] },
      assessments: [
        { source: "campus-moodle", itemId: "assessment:1", title: "Assignment 1", dueAt: "2026-08-01T00:00:00.000Z", status: "not submitted" },
      ],
      staffPosts: [],
      emailMentions: [],
      sources: { moodle: true, ed: false, ontrack: false, email: false },
    });
    const { runtime } = fauxRuntime([
      fauxAssistantMessage(fauxToolCall("get_course_overview", { course: "FIT2004" }), { stopReason: "toolUse" }),
      (context) => {
        expect(JSON.stringify(context.messages)).toContain("Assignment 1");
        return fauxAssistantMessage("Assignment 1 is due 1 August, not yet submitted.");
      },
    ]);
    const agent = new PiResidentAgent({
      conversations,
      jobs: store,
      repository: repository({ getCourseOverview }),
      runtime,
    });

    const result = await agent.run({ conversationId: "operator", message: "What's due in FIT2004?" });

    expect(result.answer).toBe("Assignment 1 is due 1 August, not yet submitted.");
    expect(getCourseOverview).toHaveBeenCalledWith("FIT2004");
  });

  it("runs search_items with the requested filters", async () => {
    const conversations = new MemoryConversationStore();
    const { store } = enabledJobStore();
    const searchItems = vi.fn().mockResolvedValue([]);
    const { runtime } = fauxRuntime([
      fauxAssistantMessage(
        fauxToolCall("search_items", { query: "extension", kind: "email", course: "FIT2004", limit: 5 }),
        { stopReason: "toolUse" },
      ),
      () => fauxAssistantMessage("No extension emails found."),
    ]);
    const agent = new PiResidentAgent({
      conversations,
      jobs: store,
      repository: repository({ searchItems }),
      runtime,
    });

    const result = await agent.run({ conversationId: "operator", message: "Any extension emails for FIT2004?" });

    expect(result.answer).toBe("No extension emails found.");
    expect(searchItems).toHaveBeenCalledWith({ query: "extension", kind: "email", course: "FIT2004", limit: 5 });
  });

  it("saves a plan through the save_plan tool", async () => {
    const conversations = new MemoryConversationStore();
    const { store } = enabledJobStore();
    const savePlan = vi.fn().mockResolvedValue({
      id: "plan-1",
      kind: "weekly",
      subject: "2026-W38",
      content: "Day-by-day checklist",
      createdAt: "2026-09-14T00:00:00.000Z",
      updatedAt: "2026-09-14T00:00:00.000Z",
    });
    const { runtime } = fauxRuntime([
      fauxAssistantMessage(
        fauxToolCall("save_plan", { kind: "weekly", subject: "2026-W38", content: "Day-by-day checklist" }),
        { stopReason: "toolUse" },
      ),
      () => fauxAssistantMessage("Saved your weekly plan."),
    ]);
    const agent = new PiResidentAgent({
      conversations,
      jobs: store,
      repository: repository({ savePlan }),
      runtime,
    });

    const result = await agent.run({ conversationId: "operator", message: "Save this week's plan." });

    expect(result.answer).toBe("Saved your weekly plan.");
    expect(savePlan).toHaveBeenCalledWith("weekly", "2026-W38", "Day-by-day checklist");
  });

  it("defaults to the ADR-0031 turn and timeout limits", () => {
    expect(DEFAULT_MAX_TURNS).toBe(12);
    expect(DEFAULT_TIMEOUT_MS).toBe(50_000);
  });
});

describe("buildConversationSystemPrompt", () => {
  it("includes the current UTC time, every playbook, and the read-only rules", () => {
    const prompt = buildConversationSystemPrompt(new Date("2026-09-16T03:00:00.000Z"));

    expect(prompt).toContain("2026-09-16T03:00:00.000Z");
    expect(PLAYBOOKS).toHaveLength(4);
    for (const playbook of PLAYBOOKS) {
      expect(prompt).toContain(playbook.title);
      expect(prompt).toContain(playbook.procedure);
    }
    expect(prompt).toContain("read-only");
    expect(prompt).toContain("Ask at most one clarifying question");
  });
});
