---
id: decompose-assignment
title: Decompose assignment
description: Use when the user wants an assignment broken into a day-by-day task list, or to run the unicorn decompose-assignment routine. Reads the assessment and its course bucket, splits the remaining work into dated tasks, and saves the plan.
trigger: on-demand; routine daily 08:00 local time
output: brief and plan
arguments:
  - name: assignment
    description: Optional "source:itemId" of one assessment to decompose (as returned by upcoming or search_items). Omit to scan every assessment due within 21 days that has no plan yet.
    required: false
---
Goal: turn each assessment due soon into a concrete day-by-day task list, saved as a plan.

Door tools required: `upcoming`, `search_items`, `course`, `get_plan`, `save_plan`, `write_brief`. Source
MCPs (Ed, Moodle, canvas-mcp), if mounted, are optional enrichment for reading a spec or staff answers in
more detail — use them if available, but this procedure must complete on door tools alone.

Respect every line `run_playbook` returned under `corrections` (verbatim `remember` notes) — for example a
stated weekend-work preference overrides the default in step 6.

1. Build the candidate list.
   - If the `assignment` argument was given, treat it as the one candidate. If it already looks like
     `source:itemId`, use it directly. Otherwise call `search_items({ query: assignment, kind:
     "assessment" })` and take the best match.
   - Otherwise call `upcoming({ days: 21 })` and keep every item with a `dueAt` whose `state` is not a
     submitted or completed state.
2. For each candidate, form its plan subject as exactly `"<source>:<itemId>"` (for example
   `campus-moodle:assessment:123`). This must match character-for-character what `save_plan` and
   `get_plan` use for the same item, or the plan will silently duplicate instead of updating.
3. Call `get_plan({ kind: "assignment", subject })`. If a plan already exists (`plan` is not null), skip
   this candidate — it already has a plan; never overwrite one a human or an earlier run wrote.
4. For each remaining candidate, call `course({ code })` for its course. Read the matching bucket
   (`course/<CODE>/<assignment-slug>`) for the assessment's own item (the spec or body) and every item
   alongside it (staff answers on its thread). If a source MCP for that course is mounted, you may read
   the live spec there for more detail — never required.
5. If the assessment's body is empty or missing, and nothing in the bucket describes it, and no source
   MCP filled the gap either, do not invent a plan for it: note in the brief that its spec could not be
   found, and move to the next candidate.
6. Otherwise split the remaining work into 3-7 concrete tasks (for example: read spec and rubric, design
   test cases, implement core logic, write the report section, submit and confirm receipt). Give each
   task an estimated hour count that sums to a realistic total for the assessment's weight. Spread the
   tasks across the days remaining until `dueAt`, lighter on weekends unless a correction says otherwise.
7. Save with `save_plan({ kind: "assignment", subject, content: "<the day-by-day task list as markdown,
   GitHub task syntax for each task>" })`.
8. Write `write_brief({ kind: "assignment-plan", subject, title: "<course code> — <assessment title>",
   body: "<the same task list>", idempotencyKey: subject })`.
9. If there are no candidates at all (nothing due within 21 days lacks a plan, or the named `assignment`
   was not found), do not call `save_plan` or `write_brief` for it — there is nothing to save. Say so
   plainly instead.

When run interactively: tell the user which assessment(s) got a new plan and read out the day-by-day list
for each. For a named `assignment` argument that already had a plan, say so and show the existing plan
(via `get_plan`) instead of silently doing nothing.
