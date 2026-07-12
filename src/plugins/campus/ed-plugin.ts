import type { Facet, ItemInput } from "../../kernel/types";
import type { Plugin } from "../plugin";
import { asArray, asBoolean, asNumber, asRecord, asString, toJson } from "../source-values";

export interface EdPluginOptions {
  token: string;
  apiBaseUrl?: string;
  fetch?: typeof fetch;
  now?: () => Date;
  threadLimit?: number;
}

export class EdPlugin implements Plugin {
  readonly id = "campus-ed";
  private readonly token: string;
  private readonly apiBaseUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly now: () => Date;
  private readonly threadLimit: number;

  constructor(options: EdPluginOptions) {
    this.token = options.token;
    this.apiBaseUrl = ensureTrailingSlash(options.apiBaseUrl ?? "https://edstem.org/api/");
    if (options.fetch) {
      const injectedFetch = options.fetch;
      this.fetcher = (input, init) => injectedFetch(input, init);
    } else {
      this.fetcher = globalThis.fetch.bind(globalThis);
    }
    this.now = options.now ?? (() => new Date());
    this.threadLimit = Math.min(Math.max(options.threadLimit ?? 30, 1), 100);
  }

  async pull(): Promise<ItemInput[]> {
    const identity = await this.get("user");
    const courses = asArray(identity.courses)
      .map((enrollment) => asRecord(asRecord(enrollment).course))
      .filter((course) => asNumber(course.id) > 0 && asString(course.status) !== "archived");
    const courseItems = courses.map((course) => this.mapCourse(course));
    const threadGroups = await Promise.all(
      courses.map(async (course) => {
        const courseId = asNumber(course.id);
        const data = await this.get(`courses/${courseId}/threads`, {
          limit: String(this.threadLimit),
          offset: "0",
          sort: "new",
        });
        return asArray(data.threads).map((thread) => this.mapThread(asRecord(thread), courseId));
      }),
    );
    return [...courseItems, ...threadGroups.flat()];
  }

  private async get(path: string, params: Record<string, string> = {}): Promise<Record<string, unknown>> {
    const url = new URL(path, this.apiBaseUrl);
    for (const [name, value] of Object.entries(params)) {
      url.searchParams.set(name, value);
    }
    const response = await this.fetcher(url, {
      headers: { Accept: "application/json", Authorization: `Bearer ${this.token}` },
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 401) {
      throw new Error("Ed authentication failed.");
    }
    if (!response.ok) {
      throw new Error(`Ed API returned HTTP ${response.status}.`);
    }
    return asRecord(await response.json());
  }

  private mapCourse(course: Record<string, unknown>): ItemInput {
    const id = asNumber(course.id);
    const status = asString(course.status) || "active";
    const year = asString(course.year);
    return {
      id: `course:${id}`,
      source: this.id,
      kind: "course",
      title: asString(course.name) || asString(course.code) || `Ed course ${id}`,
      timestamp: /^\d{4}$/.test(year) ? `${year}-01-01T00:00:00.000Z` : "1970-01-01T00:00:00.000Z",
      url: `https://edstem.org/us/courses/${id}/discussion/`,
      raw: toJson(course),
      facets: [
        {
          type: "course-identity",
          data: {
            platform: "ed",
            platformId: String(id),
            code: asString(course.code),
            status,
          },
          capabilities: [{ name: "has-course-status", primitive: "state", field: "status" }],
        },
      ],
    };
  }

  private mapThread(thread: Record<string, unknown>, fallbackCourseId: number): ItemInput {
    const id = asNumber(thread.id);
    const number = asNumber(thread.number);
    const courseId = asNumber(thread.course_id) || fallbackCourseId;
    const userId = asNumber(thread.user_id);
    const facets: Facet[] = [
      {
        type: "course-membership",
        data: { course: `course:${courseId}` },
        capabilities: [{ name: "belongs-to-course", primitive: "relation", field: "course" }],
      },
      {
        type: "author",
        data: { actor: `ed-user:${userId}` },
        capabilities: [{ name: "has-author", primitive: "actor", field: "actor" }],
      },
      {
        type: "discussion-state",
        data: {
          answerStatus: asBoolean(thread.is_answered) ? "answered" : "unanswered",
          lockStatus: asBoolean(thread.is_locked) ? "locked" : "open",
          pinStatus: asBoolean(thread.is_pinned) ? "pinned" : "normal",
        },
        capabilities: [
          { name: "has-answer-status", primitive: "state", field: "answerStatus" },
          { name: "has-lock-status", primitive: "state", field: "lockStatus" },
          { name: "has-pin-status", primitive: "state", field: "pinStatus" },
        ],
      },
      {
        type: "engagement",
        data: {
          replies: asNumber(thread.reply_count),
          votes: asNumber(thread.vote_count),
          views: asNumber(thread.view_count),
          stars: asNumber(thread.star_count),
        },
        capabilities: [
          { name: "has-reply-count", primitive: "scalar", field: "replies" },
          { name: "has-vote-count", primitive: "scalar", field: "votes" },
          { name: "has-view-count", primitive: "scalar", field: "views" },
          { name: "has-star-count", primitive: "scalar", field: "stars" },
        ],
      },
    ];
    const createdAt = asString(thread.created_at) || this.now().toISOString();
    const body = asString(thread.document);
    return {
      id: `thread:${id}`,
      source: this.id,
      kind: "thread",
      title: asString(thread.title) || `Ed thread ${number || id}`,
      timestamp: new Date(createdAt).toISOString(),
      url: `https://edstem.org/us/courses/${courseId}/discussion/${number}`,
      ...(body ? { body } : {}),
      raw: toJson(thread),
      facets,
    };
  }
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}
