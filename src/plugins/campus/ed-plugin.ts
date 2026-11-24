import { EdApiError, EdClient, type Comment, type Course, type Thread } from "edstem-cli/core";
import { normalizeTerm } from "../../kernel/courses";
import type { Facet, ItemInput } from "../../kernel/types";
import type { Plugin } from "../plugin";
import { toJson } from "../source-values";
import { HttpStatusError } from "../http-error";

// edstem-cli's EdClient talks to Ed; this plugin maps what it returns into kernel items.

// Ed's web app is region-scoped by URL path (edstem.org/us/..., /au/..., /eu/...);
// verified against edstem-archiver's course URLs. The JSON API is a host per region
// (edstem.org for AU, us.edstem.org, eu.edstem.org) and a token works on one of them;
// src/sources.ts picks `apiBaseUrl` from the region it detected for the token.
export type EdRegion = "us" | "au" | "eu";

export interface EdPluginOptions {
  token: string;
  apiBaseUrl?: string;
  /** Web-app region for course/thread URLs (edstem.org/<region>/...). Default "au". */
  region?: EdRegion;
  fetch?: typeof fetch;
  now?: () => Date;
  threadLimit?: number;
}

// One thread as the panel's reader shows it: the question, its answers and every comment,
// with authors resolved from the `users` list Ed sends next to the thread.
export interface EdPost {
  author: string;
  role: string | null;
  at: string;
  body: string;
  endorsed: boolean;
  votes: number;
  replies: EdPost[];
}

export interface EdThreadView {
  title: string;
  category: string | null;
  url: string;
  post: EdPost;
  answers: EdPost[];
  comments: EdPost[];
}

export class EdPlugin implements Plugin {
  readonly id = "campus-ed";
  private readonly client: EdClient;
  private readonly region: EdRegion;
  private readonly now: () => Date;
  private readonly threadLimit: number;

  constructor(options: EdPluginOptions) {
    const injectedFetch = options.fetch;
    this.client = new EdClient({
      token: options.token,
      apiBaseUrl: options.apiBaseUrl ?? "https://edstem.org/api/",
      ...(injectedFetch ? { fetch: (input, init) => injectedFetch(input, init) } : {}),
    });
    this.region = options.region ?? "au";
    this.now = options.now ?? (() => new Date());
    this.threadLimit = Math.min(Math.max(options.threadLimit ?? 30, 1), 100);
  }

  async pull(): Promise<ItemInput[]> {
    const identity = await edCall(() => this.client.fetchUser());
    const courses = identity.courses.filter((course) => course.id > 0 && course.status !== "archived");
    const threadGroups = await Promise.all(
      courses.map(async (course) => {
        const threads = await edCall(() => this.client.fetchThreads(course.id, { limit: this.threadLimit, sort: "new" }));
        return threads.map((thread) => this.mapThread(thread, course.id));
      }),
    );
    return [...courses.map((course) => this.mapCourse(course)), ...threadGroups.flat()];
  }

  /** Reads one thread with its answers and comments, live from Ed. */
  async thread(threadId: number): Promise<EdThreadView> {
    const thread = await edCall(() => this.client.fetchThread(threadId));
    const post = (raw: Thread | Comment): EdPost => {
      const anonymous = raw.isAnonymous || !raw.author;
      return {
        author: anonymous ? "Anonymous" : raw.author!.name || "Someone",
        role: anonymous ? null : raw.author!.courseRole || raw.author!.role || null,
        at: raw.createdAt,
        body: raw.document,
        endorsed: raw.isEndorsed,
        votes: "voteCount" in raw ? raw.voteCount : raw.metrics.voteCount,
        replies: raw.comments.map(post),
      };
    };
    return {
      title: thread.title || `Ed thread ${threadId}`,
      category: thread.category || null,
      url: `https://edstem.org/${this.region}/courses/${thread.courseId}/discussion/${thread.number || threadId}`,
      post: post(thread),
      answers: thread.answers.map(post),
      comments: thread.comments.map(post),
    };
  }

  private mapCourse(course: Course): ItemInput {
    const { id, year } = course;
    // Ed reports the offering as separate `session` ("S1") and `year` ("2026")
    // fields; either alone is still a usable term (ADR-0036).
    const term = normalizeTerm(course.session && year ? `${course.session} ${year}` : course.session || year || null);
    return {
      id: `course:${id}`,
      source: this.id,
      kind: "course",
      title: course.name || course.code || `Ed course ${id}`,
      timestamp: /^\d{4}$/.test(year) ? `${year}-01-01T00:00:00.000Z` : "1970-01-01T00:00:00.000Z",
      url: `https://edstem.org/${this.region}/courses/${id}/discussion/`,
      raw: toJson(course),
      facets: [
        {
          type: "course-identity",
          data: {
            platform: "ed",
            platformId: String(id),
            code: course.code,
            status: course.status || "active",
            ...(term ? { term } : {}),
          },
          capabilities: [{ name: "has-course-status", primitive: "state", field: "status" }],
        },
      ],
    };
  }

  private mapThread(thread: Thread, fallbackCourseId: number): ItemInput {
    const courseId = thread.courseId || fallbackCourseId;
    // ADR-0031: authorRole feeds the forum-brief playbook's staff detection
    // (list_staff_posts). Ed gives the poster's course role (student/tutor/admin)
    // or, in older payloads, only a role; either is trusted when present.
    const role = thread.author?.courseRole || thread.author?.role || "";
    const facets: Facet[] = [
      {
        type: "course-membership",
        data: { course: `course:${courseId}` },
        capabilities: [{ name: "belongs-to-course", primitive: "relation", field: "course" }],
      },
      {
        type: "author",
        data: { actor: `ed-user:${thread.userId}`, ...(role ? { authorRole: role } : {}) },
        capabilities: [{ name: "has-author", primitive: "actor", field: "actor" }],
      },
      {
        type: "discussion-state",
        data: {
          answerStatus: thread.isAnswered ? "answered" : "unanswered",
          lockStatus: thread.isLocked ? "locked" : "open",
          pinStatus: thread.isPinned ? "pinned" : "normal",
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
          replies: thread.metrics.replyCount,
          votes: thread.metrics.voteCount,
          stars: thread.metrics.starCount,
        },
        capabilities: [
          { name: "has-reply-count", primitive: "scalar", field: "replies" },
          { name: "has-vote-count", primitive: "scalar", field: "votes" },
          { name: "has-star-count", primitive: "scalar", field: "stars" },
        ],
      },
    ];
    // ADR-0036: Ed's thread category (e.g. "Assignments") feeds structural
    // bucket labelling by matching it against a course's assessment titles.
    // No capabilities — this is structure, not a behavior primitive.
    if (thread.category) {
      facets.push({
        type: "discussion-category",
        data: { category: thread.category, ...(thread.subcategory ? { subcategory: thread.subcategory } : {}) },
        capabilities: [],
      });
    }
    const createdAt = thread.createdAt || this.now().toISOString();
    return {
      id: `thread:${thread.id}`,
      source: this.id,
      kind: "thread",
      title: thread.title || `Ed thread ${thread.number || thread.id}`,
      timestamp: new Date(createdAt).toISOString(),
      url: `https://edstem.org/${this.region}/courses/${courseId}/discussion/${thread.number}`,
      ...(thread.document ? { body: thread.document } : {}),
      raw: toJson(stableThread(thread)),
      facets,
    };
  }
}

// Ed's errors become HttpStatusError, which the scheduler and the thread reader already
// read (401 means the token needs replacing, 403/404 a thread the user can't see).
async function edCall<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (!(error instanceof EdApiError) || error.statusCode === 0) throw error;
    throw new HttpStatusError(error.statusCode, error.statusCode === 401 ? "Ed authentication failed." : error.message);
  }
}

// Fields that tick on every read (view counters), track this user's own read
// state, or bump on activity nothing here tracks (Ed's updated_at moved on
// ~a third of threads per hour with no reply/vote/state change). Keeping them
// would make every sync see a "changed" thread and rewrite the item and its
// facets for nothing; any real change still moves a field that stays.
function stableThread(thread: Thread): Record<string, unknown> {
  const { updatedAt: _updatedAt, isSeen: _isSeen, metrics, ...stable } = thread;
  const { viewCount: _views, uniqueViewCount: _uniqueViews, newReplyCount: _newReplies, ...counts } = metrics;
  return { ...stable, metrics: counts };
}
