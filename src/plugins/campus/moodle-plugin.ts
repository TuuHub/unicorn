import { parseTerm } from "../../kernel/courses";
import type { Facet, ItemInput } from "../../kernel/types";
import { parseSesskey } from "../../moodle-probe";
import { HttpStatusError } from "../http-error";
import type { Plugin } from "../plugin";
import {
  asArray,
  asBoolean,
  asNumber,
  asOptionalNumber,
  asRecord,
  asString,
  toJson,
} from "../source-values";

const COURSES_METHOD = "core_course_get_enrolled_courses_by_timeline_classification";
const TIMELINE_METHOD = "core_calendar_get_action_events_by_timesort";
const ASSESSMENT_MODULES = new Set(["assign", "choice", "lesson", "quiz", "workshop"]);

// Overdue work Moodle still lists as needing action stays in view for this long.
const OVERDUE_WINDOW_DAYS = 28;
// Moodle rejects a timeline page over 50 events ("Limit must be between 1 and 50").
const TIMELINE_LIMIT = 50;

export interface MoodlePluginOptions {
  baseUrl: string;
  session: string;
  // Moodle sites may rename the cookie (MoodleSessionlearning and the like).
  cookieName?: string;
  // Signs in again (Okta) when Moodle has dropped the session; null when nothing can.
  renew?: () => Promise<{ name: string; value: string } | null>;
  fetch?: typeof fetch;
  now?: () => Date;
}

export class MoodlePlugin implements Plugin {
  readonly id = "campus-moodle";
  private readonly baseUrl: string;
  private session: string;
  private cookieName: string;
  private readonly renew: MoodlePluginOptions["renew"];
  private completeKinds: string[] = [];
  private readonly fetcher: typeof fetch;
  private readonly now: () => Date;

  constructor(options: MoodlePluginOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.session = options.session;
    this.cookieName = options.cookieName || "MoodleSession";
    this.renew = options.renew;
    if (options.fetch) {
      const injectedFetch = options.fetch;
      this.fetcher = (input, init) => injectedFetch(input, init);
    } else {
      this.fetcher = globalThis.fetch.bind(globalThis);
    }
    this.now = options.now ?? (() => new Date());
  }

  /** Kinds the last pull listed in full: anything of these kinds it left out is gone from Moodle. */
  complete(): string[] {
    return this.completeKinds;
  }

  async pull(): Promise<ItemInput[]> {
    this.completeKinds = [];
    let dashboard = await this.dashboard();
    // A 3xx is Moodle sending a signed-out visitor to its login page.
    if (dashboard.status >= 300 && dashboard.status < 400 && this.renew) {
      const cookie = await this.renew();
      if (cookie) {
        this.session = cookie.value;
        this.cookieName = cookie.name;
        dashboard = await this.dashboard();
      }
    }
    if (!dashboard.ok) {
      throw new HttpStatusError(dashboard.status, `Moodle dashboard returned HTTP ${dashboard.status}.`);
    }
    const headers = { cookie: `${this.cookieName}=${this.session}` };
    const sesskey = parseSesskey(await dashboard.text());
    const now = this.now();
    const nowSeconds = Math.floor(now.getTime() / 1000);
    const methods = [COURSES_METHOD, TIMELINE_METHOD];
    const url = new URL("/lib/ajax/service.php", this.baseUrl);
    url.searchParams.set("sesskey", sesskey);
    url.searchParams.set("info", methods.join(","));

    const response = await this.fetcher(url, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify([
        {
          index: 0,
          methodname: COURSES_METHOD,
          args: { classification: "inprogress", limit: 100, offset: 0, sort: "fullname" },
        },
        {
          index: 1,
          methodname: TIMELINE_METHOD,
          args: {
            limitnum: TIMELINE_LIMIT,
            timesortfrom: nowSeconds - OVERDUE_WINDOW_DAYS * 86_400,
            timesortto: 0,
            aftereventid: 0,
            limittononsuspendedevents: true,
          },
        },
      ]),
    });
    if (!response.ok) {
      throw new HttpStatusError(response.status, `Moodle AJAX returned HTTP ${response.status}.`);
    }

    const envelope = await response.json();
    if (!Array.isArray(envelope) || envelope.length !== 2) {
      throw new Error("Moodle AJAX returned an invalid batch response.");
    }
    for (const entry of envelope) {
      const result = asRecord(entry);
      if (result.error) {
        const exception = asRecord(result.exception);
        throw new Error(`Moodle AJAX failed: ${asString(exception.errorcode) || "unknown_error"}.`);
      }
    }

    const coursesData = asRecord(asRecord(envelope[0]).data);
    const timelineData = asRecord(asRecord(envelope[1]).data);
    const courses = asArray(coursesData.courses).map((course) => this.mapCourse(asRecord(course), now));
    const events = asArray(timelineData.events);
    // Moodle drops an event from the timeline once it needs no action (handed in, closed).
    // A full page may have cut some off, so only a short one says the rest are done.
    this.completeKinds = events.length < TIMELINE_LIMIT ? ["course", "assessment"] : ["course"];
    const assessments = events
      .map(asRecord)
      .filter(isAssessmentEvent)
      .map((event) => this.mapAssessment(event))
      .filter((item): item is ItemInput => item !== null);
    return [...courses, ...assessments];
  }

  private dashboard(): Promise<Response> {
    return this.fetcher(`${this.baseUrl}/my/`, { headers: { cookie: `${this.cookieName}=${this.session}` }, redirect: "manual" });
  }

  private mapCourse(course: Record<string, unknown>, now: Date): ItemInput {
    const id = asNumber(course.id);
    const startdate = asNumber(course.startdate);
    const visible = asBoolean(course.visible, true);
    const status = visible ? "active" : "hidden";
    const shortname = asString(course.shortname);
    const term = parseTerm(shortname) ?? parseTerm(asString(course.fullname));
    return {
      id: `course:${id}`,
      source: this.id,
      kind: "course",
      title: asString(course.fullname) || shortname || `Moodle course ${id}`,
      timestamp: startdate > 0 ? new Date(startdate * 1000).toISOString() : "1970-01-01T00:00:00.000Z",
      url: `${this.baseUrl}/course/view.php?id=${id}`,
      raw: toJson(course),
      facets: [
        {
          type: "course-identity",
          data: {
            platform: "moodle",
            platformId: String(id),
            code: shortname,
            status,
            ...(term ? { term } : {}),
          },
          capabilities: [{ name: "has-visibility", primitive: "state", field: "status" }],
        },
      ],
    };
  }

  private mapAssessment(event: Record<string, unknown>): ItemInput | null {
    const id = asNumber(event.id);
    const due = asNumber(event.timesort) || asNumber(event.timestart);
    if (id <= 0 || due <= 0) {
      return null;
    }
    const dueAt = new Date(due * 1000).toISOString();
    const course = asRecord(event.course);
    const action = asRecord(event.action);
    const courseId = asNumber(course.id);
    const status = submissionStatus(event, action);
    const facets: Facet[] = [
      {
        type: "deadline",
        data: { dueAt },
        capabilities: [{ name: "has-deadline", primitive: "temporal", field: "dueAt" }],
      },
      {
        type: "course-membership",
        data: { course: `course:${courseId}` },
        capabilities: [{ name: "belongs-to-course", primitive: "relation", field: "course" }],
      },
      {
        type: "submission",
        data: { status },
        capabilities: [{ name: "has-submission-status", primitive: "state", field: "status" }],
      },
    ];
    const grade = firstNumber(event.grade, event.gradevalue, event.grade_value, action.grade);
    if (grade !== null) {
      facets.push({
        type: "grade",
        data: { grade },
        capabilities: [{ name: "has-grade", primitive: "scalar", field: "grade" }],
      });
    }

    return {
      id: `assessment:${id}`,
      source: this.id,
      kind: "assessment",
      title: asString(event.name) || asString(event.activityname) || `Moodle event ${id}`,
      timestamp: dueAt,
      ...(asString(event.url) ? { url: asString(event.url) } : {}),
      raw: toJson(event),
      facets,
    };
  }
}

function isAssessmentEvent(event: Record<string, unknown>): boolean {
  return asString(event.purpose) === "assessment" || ASSESSMENT_MODULES.has(asString(event.modulename));
}

function submissionStatus(event: Record<string, unknown>, action: Record<string, unknown>): string {
  const explicit =
    asString(event.submissionstatus) ||
    asString(event.submission_status) ||
    asString(action.submissionstatus) ||
    asString(action.submission_status);
  if (explicit) {
    return explicit;
  }
  return "unknown";
}

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const number = asOptionalNumber(value);
    if (number !== null) {
      return number;
    }
  }
  return null;
}
