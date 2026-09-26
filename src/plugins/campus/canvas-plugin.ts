import type { Facet, ItemInput } from "../../kernel/types";
import type { Plugin } from "../plugin";
import { asArray, asBoolean, asNumber, asOptionalNumber, asRecord, asString, toJson } from "../source-values";

// Canvas LMS ingest plugin (ADR-0038).
//
// Endpoints, params and field names verified against the official Canvas API docs:
// - Courses (list for current user):        https://canvas.instructure.com/doc/api/courses.html
// - Assignments (+ include[]=submission):   https://canvas.instructure.com/doc/api/assignments.html
// - Submission object (workflow_state/missing/late/score): https://canvas.instructure.com/doc/api/submissions.html
// - Announcements:                          https://canvas.instructure.com/doc/api/announcements.html
// - Discussion topics (author, is_announcement): https://canvas.instructure.com/doc/api/discussion_topics.html
// - Pagination (Link header, rel="next"):    https://canvas.instructure.com/doc/api/file.pagination.html
//
// ADR-0038 names vishalsachdev/canvas-mcp (https://github.com/vishalsachdev/canvas-mcp)
// as the reference implementation to follow for pagination and the course cache:
// walk `rel="next"` Link-header pages with `per_page=100`, capped, and resolve
// each course once per pull instead of re-fetching a course's code per call.
// This plugin is a single-shot `pull()` (no long-lived process to keep a cache
// warm across pulls), so the "cache" is simply the in-memory `courses` array
// built once and reused for every per-course facet below.
//
// Subrequest budget (Cloudflare Workers free plan: 50 subrequests/invocation).
// Per course we make at most PER_COURSE_PAGE_CAP pages each for assignments,
// announcements and discussions; courses themselves cost at most COURSE_PAGE_CAP.
// Worst case for a 6-course student: COURSE_PAGE_CAP + 3 * PER_COURSE_PAGE_CAP * 6
// = 2 + 3*2*6 = 38, comfortably under 50. A typical course fits one page per
// endpoint, so a real pull costs roughly 1 + 3*6 = 19 subrequests.
//
// Every next-page URL is checked against baseUrl's origin before it's ever
// fetched (see isTrustedOrigin): the bearer token must never be sent to a
// host other than the configured Canvas instance, even if a paginated
// response tries to hand back a Link header pointing elsewhere.
const PER_PAGE = 100;
const COURSE_PAGE_CAP = 2;
const PER_COURSE_PAGE_CAP = 2;
const TIMEOUT_MS = 15_000;
const DEFAULT_ANNOUNCEMENT_WINDOW_DAYS = 60;
const DEFAULT_DISCUSSION_LIMIT = 30;
const EPOCH = "1970-01-01T00:00:00.000Z";

export interface CanvasPluginOptions {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
  now?: () => Date;
  /** How many days back to look for announcements. Default 60. */
  announcementWindowDays?: number;
  /** How many discussion topics per course to pull, most recent first. Default 30. */
  discussionLimit?: number;
}

class CanvasApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export class CanvasPlugin implements Plugin {
  readonly id = "campus-canvas";
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetcher: typeof fetch;
  private readonly now: () => Date;
  private readonly announcementWindowDays: number;
  private readonly discussionLimit: number;
  private readonly origin: string;

  constructor(options: CanvasPluginOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.origin = new URL(this.baseUrl).origin;
    this.token = options.token;
    if (options.fetch) {
      const injectedFetch = options.fetch;
      this.fetcher = (input, init) => injectedFetch(input, init);
    } else {
      this.fetcher = globalThis.fetch.bind(globalThis);
    }
    this.now = options.now ?? (() => new Date());
    this.announcementWindowDays = options.announcementWindowDays ?? DEFAULT_ANNOUNCEMENT_WINDOW_DAYS;
    this.discussionLimit = Math.min(Math.max(options.discussionLimit ?? DEFAULT_DISCUSSION_LIMIT, 1), 100);
  }

  async pull(): Promise<ItemInput[]> {
    const coursesUrl = new URL(`${this.baseUrl}/api/v1/courses`);
    coursesUrl.searchParams.set("enrollment_type", "student");
    coursesUrl.searchParams.set("enrollment_state", "active");
    coursesUrl.searchParams.set("include[]", "term");
    coursesUrl.searchParams.set("per_page", String(PER_PAGE));
    const rawCourses = await this.getAllPages(coursesUrl, COURSE_PAGE_CAP);
    const courses = rawCourses.map(asRecord).filter((course) => asNumber(course.id) > 0);
    const courseItems = courses.map((course) => this.mapCourse(course));

    const announcementSince = new Date(
      this.now().getTime() - this.announcementWindowDays * 24 * 60 * 60 * 1000,
    ).toISOString();

    const perCourseItems = await Promise.all(
      courses.map((course) => this.pullCourse(asNumber(course.id), announcementSince)),
    );

    return [...courseItems, ...perCourseItems.flat()];
  }

  private async pullCourse(courseId: number, announcementSince: string): Promise<ItemInput[]> {
    const [assignments, announcements, discussions] = await Promise.all([
      this.pullAssignments(courseId),
      this.pullAnnouncements(courseId, announcementSince),
      this.pullDiscussions(courseId),
    ]);
    return [
      ...assignments.map((assignment) => this.mapAssignment(asRecord(assignment), courseId)),
      ...announcements.map((announcement) => this.mapAnnouncement(asRecord(announcement), courseId)),
      ...discussions.map((topic) => this.mapDiscussion(asRecord(topic), courseId)),
    ];
  }

  private async pullAssignments(courseId: number): Promise<unknown[]> {
    const url = new URL(`${this.baseUrl}/api/v1/courses/${courseId}/assignments`);
    url.searchParams.set("include[]", "submission");
    url.searchParams.set("per_page", String(PER_PAGE));
    return this.getAllPagesTolerant(url, courseId, "assignments");
  }

  private async pullAnnouncements(courseId: number, since: string): Promise<unknown[]> {
    const url = new URL(`${this.baseUrl}/api/v1/announcements`);
    url.searchParams.set("context_codes[]", `course_${courseId}`);
    url.searchParams.set("start_date", since);
    url.searchParams.set("active_only", "true");
    url.searchParams.set("per_page", String(PER_PAGE));
    return this.getAllPagesTolerant(url, courseId, "announcements");
  }

  private async pullDiscussions(courseId: number): Promise<unknown[]> {
    const url = new URL(`${this.baseUrl}/api/v1/courses/${courseId}/discussion_topics`);
    url.searchParams.set("order_by", "recent_activity");
    url.searchParams.set("per_page", String(this.discussionLimit));
    const topics = await this.getAllPagesTolerant(url, courseId, "discussion_topics");
    // Belt and suspenders: `only_announcements` defaults to false, but filter
    // defensively rather than trust it, and cap to the configured limit.
    return topics.filter((topic) => !asBoolean(asRecord(topic).is_announcement)).slice(0, this.discussionLimit);
  }

  // A 403 on a per-course endpoint means that course disabled the tab (or the
  // student's role lacks that permission there) — skip it, don't fail the pull.
  // A 401 (bad token) is not caught here: it propagates from getPage() and
  // fails the whole pull, per ADR-0038.
  private async getAllPagesTolerant(url: URL, courseId: number, endpoint: string): Promise<unknown[]> {
    try {
      return await this.getAllPages(url, PER_COURSE_PAGE_CAP);
    } catch (error) {
      if (error instanceof CanvasApiError && error.status === 403) {
        console.error(JSON.stringify({ event: "canvas_tab_disabled", courseId, endpoint }));
        return [];
      }
      throw error;
    }
  }

  private async getAllPages(initialUrl: URL, pageCap: number): Promise<unknown[]> {
    const items: unknown[] = [];
    let next: string | null = initialUrl.toString();
    let pages = 0;
    while (next && pages < pageCap) {
      const page = await this.getPage(next);
      items.push(...page.items);
      // The Link header's next URL is server-supplied. Canvas always keeps
      // pagination on the same host, but never follow it (and never send the
      // bearer token) anywhere else — a compromised or misconfigured Canvas
      // instance must not be able to redirect the token to a third party.
      next = page.next && this.isTrustedOrigin(page.next) ? page.next : null;
      if (page.next && !next) {
        console.error(JSON.stringify({ event: "canvas_cross_origin_next_link_dropped" }));
      }
      pages += 1;
    }
    return items;
  }

  private isTrustedOrigin(url: string): boolean {
    try {
      return new URL(url).origin === this.origin;
    } catch {
      return false;
    }
  }

  private async getPage(url: string): Promise<{ items: unknown[]; next: string | null }> {
    const response = await this.fetcher(url, {
      headers: { Accept: "application/json", Authorization: `Bearer ${this.token}` },
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.status === 401) {
      throw new CanvasApiError(401, "Canvas authentication failed.");
    }
    if (!response.ok) {
      throw new CanvasApiError(response.status, `Canvas API returned HTTP ${response.status}.`);
    }
    const items = asArray(await response.json());
    return { items, next: nextPageUrl(response.headers.get("link")) };
  }

  private mapCourse(course: Record<string, unknown>): ItemInput {
    const id = asNumber(course.id);
    const term = asRecord(course.term);
    const termName = asString(term.name) || null;
    const status = asString(course.workflow_state) || "active";
    const startedAt = asString(course.start_at) || asString(term.start_at);
    return {
      id: `course:${id}`,
      source: this.id,
      kind: "course",
      title: asString(course.name) || asString(course.course_code) || `Canvas course ${id}`,
      timestamp: startedAt ? new Date(startedAt).toISOString() : EPOCH,
      url: `${this.baseUrl}/courses/${id}`,
      raw: toJson(course),
      facets: [
        {
          type: "course-identity",
          data: {
            platform: "canvas",
            platformId: String(id),
            code: asString(course.course_code),
            term: termName,
            status,
          },
          capabilities: [{ name: "has-course-status", primitive: "state", field: "status" }],
        },
      ],
    };
  }

  private mapAssignment(assignment: Record<string, unknown>, courseId: number): ItemInput {
    const id = asNumber(assignment.id);
    const dueAt = asString(assignment.due_at);
    const timestamp = dueAt || asString(assignment.created_at) || EPOCH;
    const submission = asRecord(assignment.submission);
    const facets: Facet[] = [
      {
        type: "course-membership",
        data: { course: `course:${courseId}` },
        capabilities: [{ name: "belongs-to-course", primitive: "relation", field: "course" }],
      },
      {
        type: "submission",
        data: { status: submissionStatus(submission) },
        capabilities: [{ name: "has-submission-status", primitive: "state", field: "status" }],
      },
    ];
    if (dueAt) {
      facets.push({
        type: "deadline",
        data: { dueAt: new Date(dueAt).toISOString() },
        capabilities: [{ name: "has-deadline", primitive: "temporal", field: "dueAt" }],
      });
    }
    const score = asOptionalNumber(submission.score);
    if (score !== null) {
      facets.push({
        type: "grade",
        data: { grade: score },
        capabilities: [{ name: "has-grade", primitive: "scalar", field: "grade" }],
      });
    }
    return {
      id: `assignment:${id}`,
      source: this.id,
      kind: "assessment",
      title: asString(assignment.name) || `Canvas assignment ${id}`,
      timestamp: new Date(timestamp).toISOString(),
      url: asString(assignment.html_url) || `${this.baseUrl}/courses/${courseId}/assignments/${id}`,
      raw: toJson(assignment),
      facets,
    };
  }

  private mapAnnouncement(announcement: Record<string, unknown>, courseId: number): ItemInput {
    const id = asNumber(announcement.id);
    const postedAt = asString(announcement.posted_at) || EPOCH;
    const author = asRecord(announcement.author);
    const authorId = asNumber(author.id);
    const body = htmlToText(asString(announcement.message));
    return {
      id: `announcement:${id}`,
      source: this.id,
      kind: "announcement",
      title: asString(announcement.title) || `Canvas announcement ${id}`,
      timestamp: new Date(postedAt).toISOString(),
      url: asString(announcement.html_url) || `${this.baseUrl}/courses/${courseId}/discussion_topics/${id}`,
      ...(body ? { body } : {}),
      raw: toJson(announcement),
      facets: [
        {
          type: "course-membership",
          data: { course: `course:${courseId}` },
          capabilities: [{ name: "belongs-to-course", primitive: "relation", field: "course" }],
        },
        {
          type: "author",
          // Canvas announcements are, by design, posts a teacher/TA makes to
          // a course; the announcements API carries no separate "role" field,
          // so authorRole is fixed the same way Ed's forum-brief detects staff.
          data: { actor: `canvas-user:${authorId}`, authorRole: "teacher" },
          capabilities: [{ name: "has-author", primitive: "actor", field: "actor" }],
        },
      ],
    };
  }

  private mapDiscussion(topic: Record<string, unknown>, courseId: number): ItemInput {
    const id = asNumber(topic.id);
    const postedAt = asString(topic.posted_at) || EPOCH;
    const author = asRecord(topic.author);
    const authorId = asNumber(author.id);
    const body = htmlToText(asString(topic.message));
    return {
      id: `discussion:${id}`,
      source: this.id,
      kind: "thread",
      title: asString(topic.title) || `Canvas discussion ${id}`,
      timestamp: new Date(postedAt).toISOString(),
      url: asString(topic.html_url) || `${this.baseUrl}/courses/${courseId}/discussion_topics/${id}`,
      ...(body ? { body } : {}),
      raw: toJson(topic),
      facets: [
        {
          type: "course-membership",
          data: { course: `course:${courseId}` },
          capabilities: [{ name: "belongs-to-course", primitive: "relation", field: "course" }],
        },
        {
          // Discussion topics carry no per-course role for their author (unlike
          // Ed's `user.course_role`), so authorRole is left out when it can't
          // be determined rather than guessed.
          type: "author",
          data: { actor: `canvas-user:${authorId}` },
          capabilities: [{ name: "has-author", primitive: "actor", field: "actor" }],
        },
      ],
    };
  }
}

function nextPageUrl(linkHeader: string | null): string | null {
  if (!linkHeader) {
    return null;
  }
  for (const segment of linkHeader.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(segment.trim());
    if (match) {
      return match[1];
    }
  }
  return null;
}

function submissionStatus(submission: Record<string, unknown>): string {
  if (asBoolean(submission.missing)) {
    return "missing";
  }
  const workflowState = asString(submission.workflow_state);
  if (workflowState === "graded") {
    return "graded";
  }
  if (asBoolean(submission.late)) {
    return "late";
  }
  if (workflowState === "submitted" || workflowState === "pending_review") {
    return "submitted";
  }
  if (workflowState === "unsubmitted") {
    return "unsubmitted";
  }
  return "unknown";
}

// Strip HTML down to readable plain text. Canvas ships announcement and
// discussion bodies as HTML fragments; this is deliberately simple (no HTML
// parser dependency) since the output only feeds text fields, never a
// rendered page — rendering code (see src/ui.ts's escapeHtml) escapes on the
// way back out.
function htmlToText(html: string): string {
  if (!html) {
    return "";
  }
  const withoutScripts = html.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ");
  const withoutTags = withoutScripts.replace(/<[^>]+>/g, " ");
  const decoded = withoutTags
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'");
  return decoded.replace(/\s+/g, " ").trim();
}
