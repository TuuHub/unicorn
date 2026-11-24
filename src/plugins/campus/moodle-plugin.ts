import { createMoodleClientCore, hasGrade, type CourseGrades, type GradeItem } from "moodle-cli/core";
import { normalizeCourseCode, parseTerm, termOrder } from "../../kernel/courses";
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
  // Reads each unit's gradebook; moodle-cli's client by default.
  readGrades?: ReadGrades;
}

export type ReadGrades = (courseIds: number[], cookie: { name: string; value: string }, sesskey: string) => Promise<CourseGrades[]>;

export class MoodlePlugin implements Plugin {
  readonly id = "campus-moodle";
  private readonly baseUrl: string;
  private session: string;
  private cookieName: string;
  private readonly renew: MoodlePluginOptions["renew"];
  private completeKinds: string[] = [];
  private readonly fetcher: typeof fetch;
  private readonly now: () => Date;
  private readonly readGrades: ReadGrades;

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
    this.readGrades = options.readGrades ?? ((ids, cookie, sesskey) => readGradesWithMoodleCli(this.baseUrl, this.fetcher, ids, cookie, sesskey));
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
    const courseRecords = asArray(coursesData.courses).map(asRecord);
    const courses = courseRecords.map((course) => this.mapCourse(course, now));
    const events = asArray(timelineData.events);
    const grades = await this.currentGrades(currentUnitIds(courseRecords), sesskey);
    const marks = new Map<number, GradeItem>();
    for (const report of grades ?? []) for (const item of report.items) if (item.cmid) marks.set(item.cmid, item);

    // Moodle drops an event from the timeline once it needs no action (handed in, closed).
    // A full page may have cut some off, so only a short one says the rest are done.
    this.completeKinds = [...(events.length < TIMELINE_LIMIT ? ["course", "assessment"] : ["course"]), ...(grades ? ["grade"] : [])];
    const assessments = events
      .map(asRecord)
      .filter(isAssessmentEvent)
      .map((event) => this.mapAssessment(event, marks))
      .filter((item): item is ItemInput => item !== null);
    const starts = new Map(courseRecords.map((course) => [asNumber(course.id), asNumber(course.startdate)]));
    const gradeItems = (grades ?? []).flatMap((report) => {
      const start = starts.get(report.course_id) ?? 0;
      // The gradebook has no dates. The unit's start is stable, so an unchanged grade costs no write.
      const timestamp = new Date(start > 0 ? start * 1000 : now.getTime()).toISOString();
      return report.items.flatMap((item, order) => (item.cmid ? [this.mapGrade(item, item.cmid, report.course_id, order, timestamp)] : []));
    });
    return [...courses, ...assessments, ...gradeItems];
  }

  // Null when the gradebook could not be read, so last pull's grades stay rather than vanish.
  private async currentGrades(courseIds: number[], sesskey: string): Promise<CourseGrades[] | null> {
    if (courseIds.length === 0) return null;
    try {
      return await this.readGrades(courseIds, { name: this.cookieName, value: this.session }, sesskey);
    } catch (error) {
      console.error(JSON.stringify({ event: "moodle_grades_failed", message: error instanceof Error ? error.message : String(error) }));
      return null;
    }
  }

  private mapGrade(item: GradeItem, cmid: number, courseId: number, order: number, timestamp: string): ItemInput {
    const marked = hasGrade(item.grade);
    return {
      id: `grade:${cmid}`,
      source: this.id,
      kind: "grade",
      title: item.name,
      timestamp,
      url: item.url || `${this.baseUrl}/mod/${item.modname}/view.php?id=${cmid}`,
      raw: toJson(item),
      facets: [
        {
          type: "course-membership",
          data: { course: `course:${courseId}` },
          capabilities: [{ name: "belongs-to-course", primitive: "relation", field: "course" }],
        },
        {
          type: "grade",
          data: {
            // A state, not a scalar: Moodle marks read "99.00 (HD)" or "Pass". Empty until marked.
            grade: marked ? item.grade : "",
            range: item.range || null,
            percentage: item.percentage || null,
            status: item.status || null,
            feedback: item.feedback || null,
            module: item.modname || null,
            order,
          },
          capabilities: [{ name: "has-grade", primitive: "state", field: "grade" }],
        },
      ],
    };
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

  private mapAssessment(event: Record<string, unknown>, marks: Map<number, GradeItem>): ItemInput | null {
    const id = asNumber(event.id);
    const due = asNumber(event.timesort) || asNumber(event.timestart);
    if (id <= 0 || due <= 0) {
      return null;
    }
    const dueAt = new Date(due * 1000).toISOString();
    const course = asRecord(event.course);
    const action = asRecord(event.action);
    const courseId = asNumber(course.id);
    const cmid = moduleId(asString(event.url));
    const mark = cmid ? marks.get(cmid) : undefined;
    const marked = mark && hasGrade(mark.grade) ? mark : undefined;
    const status = marked ? "graded" : submissionStatus(event, action);
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
    const grade = marked?.grade ?? firstNumber(event.grade, event.gradevalue, event.grade_value, action.grade);
    if (grade !== null) {
      facets.push({
        type: "grade",
        data: marked ? { grade, range: marked.range || null } : { grade },
        capabilities: [{ name: "has-grade", primitive: marked ? "state" : "scalar", field: "grade" }],
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

async function readGradesWithMoodleCli(
  baseUrl: string,
  fetcher: typeof fetch,
  courseIds: number[],
  cookie: { name: string; value: string },
  sesskey: string,
): Promise<CourseGrades[]> {
  const client = createMoodleClientCore(baseUrl, { cookie, sesskey, fetchImpl: fetcher });
  const reports: CourseGrades[] = [];
  for (const id of courseIds) reports.push(await client.getCourseGrades(id));
  return reports;
}

// The units of the latest term: hubs, portals and last term's units have no gradebook worth reading.
function currentUnitIds(courses: Record<string, unknown>[]): number[] {
  const units = courses.flatMap((course) => {
    const shortname = asString(course.shortname);
    const term = parseTerm(shortname) ?? parseTerm(asString(course.fullname));
    return normalizeCourseCode(shortname) && term ? [{ id: asNumber(course.id), term }] : [];
  });
  const latest = units.map((unit) => unit.term).sort((left, right) => termOrder(left).localeCompare(termOrder(right))).at(-1);
  return units.filter((unit) => unit.term === latest && unit.id > 0).map((unit) => unit.id);
}

// The course-module id in an activity link (mod/quiz/view.php?id=6031122).
function moduleId(url: string): number | null {
  const match = url.match(/\/mod\/\w+\/view\.php\?(?:[^#]*&)?id=(\d+)/);
  return match ? Number(match[1]) : null;
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
