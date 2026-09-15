---
id: forum-brief
title: Forum brief
trigger: daily, on-demand
output: brief
---
Goal: report what teaching staff said on Ed since the last forum brief.

1. Call list_courses to see every active unit.
2. For each unit whose `sources.ed` is true (skip units with no Ed data — say so
   only if the caller asked about that specific unit), call
   list_staff_posts(course, since) with `since` set to the last forum brief's
   timestamp from the caller's context, or 24 hours ago when none is given. A
   thread already counts as staff-authored when its author role is staff, tutor
   or admin, or the thread is an announcement, or the thread is pinned —
   list_staff_posts already applies this filter, so do not re-derive it.
3. Group the results by unit. For each thread, write one line: what changed for
   the student (a new announcement, a staff reply, a pinned clarification) and
   its URL.
4. Skip any unit with nothing new — do not print a unit heading with zero
   threads under it.
5. If every unit has nothing new, output exactly the line NOTHING_TO_REPORT and
   nothing else.

Output: one heading per unit with new staff activity, one line per thread
underneath it.
