---
id: weekly-plan
title: Weekly plan
trigger: on-demand, weekly
output: brief
---
Goal: a day-by-day checklist for the next 7 days across every enrolled unit.

1. Call list_courses to see every enrolled unit (unit codes look like FIT2004).
2. For each active unit, call get_course_overview(course) to pull assessments due
   within 14 days with submission status, staff posts from the last 7 days, and the
   `sources` flags (moodle, ed, ontrack, email). If `sources.ontrack` is false, an
   OnTrack-style task source is not connected for that unit — do not guess at task
   state for it. If `sources.moodle` or `sources.ed` is false, say the unit has no
   data from that source instead of treating silence as "nothing due".
3. Call search_items with kind "email" and terms such as "extension", "reschedule",
   "due", "exam", "quiz" for unit codes that showed nothing unusual in step 2 — a
   deadline change sometimes only arrives by email.
4. Rank items by due date, then by effort (a report or project outranks a 5-minute
   quiz due the same day).
5. Lay out a checklist for each of the next 7 days, dated explicitly. Put multi-day
   work on earlier days rather than the day before it is due.
6. If two deadlines collide on the same day, or an assessment's submission status is
   "unknown" and no spec is available for it, list it under "Needs your input" and
   ask at most one clarifying question about the single most important ambiguity.
7. Save the result with save_plan("weekly", "<ISO week, e.g. 2026-W38>", <the plan
   text you are about to output>).
8. If nothing is due in the next 7 days and there is nothing to ask about, output
   exactly the line NOTHING_TO_REPORT instead of inventing filler.

Output: a one-line title, the per-day checklist, then a "Needs your input" section
(omit it entirely when there is nothing to ask).
