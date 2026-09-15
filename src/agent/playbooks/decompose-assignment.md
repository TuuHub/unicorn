---
id: decompose-assignment
title: Decompose assignment
trigger: assessment-due-window, on-demand
output: brief and plan
---
Goal: turn one assessment into a concrete day-by-day task list before it is due.

1. Identify the assessment. If the caller gave a source and item id, call
   get_item(source, itemId) directly. Otherwise call search_items(query, kind:
   "assessment", course: "<unit code>") with the assessment name or keywords from
   the request.
2. Read the full assessment body from get_item — it returns the body uncapped;
   never plan from a clipped summary.
3. Call get_course_overview(course) for the assessment's unit code and read its
   staffPosts (last 14 days) and emailMentions for posts or emails that reference
   this assessment by name (extensions, clarified rubric, moved due date). If
   `sources.ontrack` is false for the unit, note that no OnTrack-style task tracker
   is connected instead of assuming the assessment has no linked tasks there.
4. If the assessment's submission facet already shows "submitted" (or an
   equivalent completed status), stop here and output exactly NOTHING_TO_REPORT —
   there is nothing left to decompose.
5. If the assessment body is missing, or no due date can be confirmed from any
   source, say so plainly and ask the one question that would unblock the plan.
6. Otherwise split the remaining work into 3-7 concrete tasks (for example: read
   spec and rubric, design test cases, implement core logic, write the report
   section, submit and confirm receipt). Give each task an estimated hour count
   that sums to a realistic total for the assessment's weight.
7. Spread the tasks across the days remaining until the due date. Keep weekends
   lighter unless list_memory records a preference for working weekends.
8. Save the result with save_plan("assignment", "<source item_id of the
   assessment, e.g. campus-moodle:assessment:123>", <the plan text>).

Output: the unit code and assessment title, then the day-by-day task list with
hour estimates per task.
