---
id: forum-brief
title: Forum brief
description: Use when the user wants a summary of staff forum activity since the last check, or to run the unicorn forum-brief routine. Reads changes since the last forum brief and reports staff notices per course.
trigger: on-demand; routine daily 18:00 local time
output: brief
arguments:
  - name: course
    description: Optional unit code to scope the brief to one course. Omit to cover every course.
    required: false
---
Goal: report what teaching staff posted, and what changed on forum threads, since the last forum brief.

Door tools required: `get_briefs`, `changes_since`, `write_brief`, and `course` when a specific course is
named. Source MCPs (Ed, canvas-mcp), if mounted, are optional enrichment for reading a thread in full —
use them if available, but this procedure must complete on door tools alone.

Finding the cursor:
1. Call `get_briefs({ unreadOnly: false, limit: 20 })` and find the most recent brief with `kind:
   "forum-brief"` whose `subject` matches the scope of this run — the `course` argument if one was given,
   or `"all"` if not. Its `body` ends with a machine-readable line `cursor: <n>`; parse `<n>` as the
   starting cursor.
2. If no matching previous forum-brief exists, use starting cursor `"0"` — this is the first run for that
   scope, so every event counts as new.

Gathering changes:
3. Call `changes_since({ cursor, limit: 200 })`. While `hasMore` is true, call it again with the returned
   `nextCursor` and merge the events, up to 5 calls total — cap the work rather than looping forever on a
   noisy history.
4. Keep only events of type `notice.posted` or `content.changed`, and, when a `course` argument was
   given, only events whose `course` matches it case-insensitively.
5. Group the kept events by `course`. Write one line per event: what changed for the student (a new
   staff notice, an edited thread) and its `url`. For `content.changed`, say what changed using `before`
   and `after`, not just that something did.
6. Skip any course with nothing kept — never print a course heading with zero lines under it.

Writing the brief:
7. If nothing was kept across every course, still write the brief so the cursor advances and the next run
   does not re-scan the same window: the body is "Nothing new on the forums." followed by the machine
   line from step 9.
8. Otherwise the body is one heading per course with new activity, one line per event underneath, newest
   first.
9. End the body with the machine line `cursor: <n>`, where `<n>` is the highest cursor value seen across
   steps 3-4 (or the starting cursor from step 1-2 if nothing was seen).
10. Call `write_brief({ kind: "forum-brief", subject: course ?? "all", title: "Forum brief — <course, or
    "all courses">", body: "<the body from steps 7-9>", idempotencyKey: "<subject>:<the new cursor>" })`.
    The cursor inside the idempotency key means a retried call over the same window is a no-op, while the
    next run's larger cursor still gets its own brief.

When run interactively: tell the user how many courses had new forum activity and read the lines for
each; if nothing was new, say so in one sentence.
