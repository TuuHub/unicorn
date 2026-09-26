// Types shared by D1McpRepository and its callers. Moved out of the deleted
// src/agent/tools.ts (ADR-0034): the resident agent that used to own these is
// gone, but courses/plans/remember are still real repository features.

export interface CourseSummary {
  source: string;
  itemId: string;
  code: string;
  name: string;
  platform: string;
  status: string;
}

export interface CourseAssessment {
  source: string;
  itemId: string;
  title: string;
  url?: string;
  dueAt: string | null;
  status: string | null;
}

export interface CourseStaffPost {
  source: string;
  itemId: string;
  title: string;
  url?: string;
  timestamp: string;
}

export interface CourseEmailMention {
  source: string;
  itemId: string;
  title: string;
  url?: string;
  timestamp: string;
}

export interface CourseOverview {
  query: string;
  identity: { code: string; name: string; platforms: string[] } | null;
  assessments: CourseAssessment[];
  staffPosts: CourseStaffPost[];
  emailMentions: CourseEmailMention[];
  sources: { moodle: boolean; ed: boolean; ontrack: boolean; email: boolean };
}

export interface SearchItemsQuery {
  query: string;
  kind?: string;
  since?: string;
  course?: string;
  limit: number;
}

export interface StaffPostQuery {
  course?: string;
  since?: string;
  limit: number;
}

export type PlanKind = "weekly" | "assignment";

export interface Plan {
  id: string;
  kind: PlanKind;
  subject: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

export type RememberResult = "saved" | "duplicate" | "empty";
