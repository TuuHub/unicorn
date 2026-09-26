---
id: weekly-plan
title: Weekly plan
description: Use when the user wants their week planned across every course, or to run the unicorn weekly-plan routine. Builds a 7-day checklist from due dates and course buckets, saves it as a plan, and files it as a brief.
trigger: on-demand; routine Monday 07:30 local time
output: brief
arguments: []
---
Goal: a day-by-day checklist for the next 7 days across every course, saved as a plan and a brief.

Door tools required: `upcoming`, `course`, `life`, `save_plan`, `write_brief`. Source MCPs (Ed, Moodle,
canvas-mcp, Gmail), if mounted in this session, are optional enrichment only — use them to double-check
a deadline or skim a spec, but this procedure must complete using door tools alone if none are mounted
or a call fails.

Respect every line `run_playbook` returned under `corrections` — they are the user's own verbatim
`remember` notes and override the defaults below (for example "no work on Sundays").

1. Call `upcoming({ days: 7 })` for everything with a deadline in the next 7 days across every course.
2. Call `upcoming({ days: 14 })` too — an assignment due 8-14 days out that needs several days of work
   should already appear on this week's calendar.
3. For each course code you see, call `course({ code })` for the full bucket view: submission state,
   the staff answers on that assignment's thread, and general-bucket notices. This catches anything
   `upcoming` did not carry, such as a spec change flagged in a thread.
4. Call `life()` once for non-course deadlines (club events, admin dates) that belong in the week.
5. If a source MCP for a course is mounted, you may cross-check its spec or latest staff post there —
   never required, never blocking.
6. Rank everything by due date, then by effort: a report or project outranks a five-minute quiz due the
   same day.
7. Lay out a checklist for each of the next 7 days, dated explicitly (for example "Mon 29 Sep"). Put
   multi-day work on the earlier days, not the day before it is due. Use GitHub task syntax for every
   actionable line, for example `- [ ] FIT3175: draft intro (Assignment 2)`.
8. If two deadlines collide on the same day, or an item's state is unknown and nothing you called
   explains it, add it under a "Needs your input" heading and ask at most one clarifying question about
   the single most important ambiguity. Do not let it block the rest of the plan.
9. Save the checklist with `save_plan({ kind: "weekly", subject: "<ISO week, e.g. 2026-W39>", content:
   "<the full markdown checklist>" })`. Compute the ISO week from the date the playbook runs.
10. Write `write_brief({ kind: "weekly-plan", subject: "<same ISO week>", title: "Weekly plan — <ISO
    week>", body: "<the checklist markdown>", idempotencyKey: "<same ISO week>" })`. The idempotency key
    is the ISO week, so running this playbook twice in the same week never creates a duplicate — a
    repeated key is a no-op on the server, so make the call regardless of whether you think it is a
    repeat.
11. If nothing is due in the next 14 days and there is nothing to ask about, still call `save_plan` and
    `write_brief` with a plan that plainly says "Nothing due this week." Do not invent filler, and do not
    skip either call just because the week is quiet — a client reading `get_plan` needs a real row, not
    silence.

When run interactively: tell the user the ISO week the plan covers, how many items are on it, and read
out the "Needs your input" section if one exists.
