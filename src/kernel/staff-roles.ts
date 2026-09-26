import type { Facet } from "./types";

// Author roles that count as teaching staff across the campus plugins (Ed's
// course-scoped role is one of student/tutor/admin; older payloads report
// "staff" or "instructor"). Centralised here because both the kernel (for
// notice.posted vs item.added) and the MCP repository (for staff-post
// filtering) need the same definition.
export const STAFF_ROLES = new Set(["admin", "tutor", "staff", "instructor", "teacher", "ta"]);

// True when any `author` facet on the item carries an authorRole matching
// STAFF_ROLES, case-insensitively.
export function isStaffAuthored(facets: Facet[]): boolean {
  for (const facet of facets) {
    if (facet.type !== "author") {
      continue;
    }
    const role = facet.data.authorRole;
    if (typeof role === "string" && STAFF_ROLES.has(role.toLowerCase())) {
      return true;
    }
  }
  return false;
}
