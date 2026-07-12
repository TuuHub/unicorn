import type { Facet, ItemInput, JsonValue } from "../../kernel/types";
import { parseSesskey } from "../../moodle-probe";
import type { Plugin } from "../plugin";

const COURSES_METHOD = "core_course_get_enrolled_courses_by_timeline_classification";
const TIMELINE_METHOD = "core_calendar_get_action_events_by_timesort";

export interface MoodlePluginOptions {
  baseUrl: string;
  session: string;
  fetch?: typeof fetch;
  now?: () => Date;
}

export class MoodlePlugin implements Plugin {
  readonly id = "campus-moodle";
  private readonly baseUrl: string;
  private readonly session: string;
  private readonly fetcher: typeof fetch;
  private readonly now: () => Date;

  constructor(options: MoodlePluginOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.session = options.session;
    if (options.fetch) {
      const injectedFetch = options.fetch;
      this.fetcher = (input, init) => injectedFetch(input, init);
    } else {
      this.fetcher = globalThis.fetch.bind(globalThis);
    }
    this.now = options.now ?? (() => new Date());
  }

  async pull(): Promise<ItemInput[]> {
    const headers = { cookie: `MoodleSession=${this.session}` };
    const dashboard = await this.fetcher(`${this.baseUrl}/my/`, { headers, redirect: "manual" });
    if (!dashboard.ok) {
      throw new Error(`Moodle dashboard returned HTTP ${dashboard.status}.`);
    }
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
          args: { classification: "all", limit: 100, offset: 0, sort: "fullname" },
        },
        {
          index: 1,
          methodname: TIMELINE_METHOD,
          args: {
            limitnum: 50,
            timesortfrom: nowSeconds,
            timesortto: 0,
            aftereventid: 0,
            limittononsuspendedevents: true,
          },
        },
      ]),
    });
    if (!response.ok) {
      throw new Error(`Moodle AJAX returned HTTP ${response.status}.`);
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
    const assessments = asArray(timelineData.events)
      .map((event) => this.mapAssessment(asRecord(event)))
      .filter((item): item is ItemInput => item !== null);
    return [...courses, ...assessments];
  }

  private mapCourse(course: Record<string, unknown>, now: Date): ItemInput {
    const id = asNumber(course.id);
    const startdate = asNumber(course.startdate);
    const visible = asBoolean(course.visible, true);
    const status = visible ? "active" : "hidden";
    return {
      id: `course:${id}`,
      source: this.id,
      kind: "course",
      title: asString(course.fullname) || asString(course.shortname) || `Moodle course ${id}`,
      timestamp: startdate > 0 ? new Date(startdate * 1000).toISOString() : "1970-01-01T00:00:00.000Z",
      url: `${this.baseUrl}/course/view.php?id=${id}`,
      raw: toJson(course),
      facets: [
        {
          type: "course-identity",
          data: {
            platform: "moodle",
            platformId: String(id),
            code: asString(course.shortname),
            status,
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
    const overdue = asBoolean(event.overdue);
    const actionable = asBoolean(action.actionable);
    const status = overdue ? "overdue" : actionable ? "actionable" : "inactive";
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
        type: "activity-state",
        data: { status },
        capabilities: [{ name: "has-action-state", primitive: "state", field: "status" }],
      },
    ];
    const progress = asNumber(course.progress);
    if (progress > 0) {
      facets.push({
        type: "course-progress",
        data: { progress },
        capabilities: [{ name: "has-course-progress", primitive: "scalar", field: "progress" }],
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

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Number(value) || 0;
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function toJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
