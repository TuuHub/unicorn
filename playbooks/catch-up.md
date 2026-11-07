---
id: catch-up
title: Catch up
description: Use when the user has been away (sick, travelling, busy with another unit) and asks what they missed, or says "catch me up". Summarises every change since a date across all units, ranks what needs action, and proposes a recovery plan.
trigger: on-demand
output: brief and, if accepted, a weekly plan
arguments:
  - name: since
    description: Optional ISO date the user was away from (e.g. "2026-10-28"). Omit to start from the last catch-up or the last 14 days.
    required: false
---
Goal: turn a pile of missed changes into "here is what matters, in order, and a plan to get back on track".

Door tools required: `changes_since`, `upcoming`, `course`, `get_memory`, `memory`, `write_brief`,
`save_plan`. Source MCPs, if mounted, are optional enrichment for reading a missed announcement in full.

1. The prefetched data holds `events` (changes since the start point), `overdue` and `upcoming` items, and
   `since`. If the user gave a different date, page `changes_since` yourself until `hasMore` is false and
   drop events older than that date.
2. Bucket every event into exactly one of:
   - **Act now** — a deadline missed or within 72 hours, a grade that needs a response, a staff notice that
     changes an assessment (new due date, new requirement, extension policy).
   - **Read soon** — staff answers on threads in an assessment bucket the user has work in, new lecture
     material for an upcoming assessment.
   - **Background** — everything else (student questions, minor edits, life items).
3. For each **Act now** item give one line: what changed, the unit, the deadline in the user's timezone and
   weekday, and the link. Group **Read soon** by unit. Collapse **Background** into a count per unit.
4. If anything is overdue, say so plainly first, and suggest the concrete next step (ask for special
   consideration, email the unit's staff) — never draft a fake reason for them.
5. Offer a recovery plan for the next 7 days. If accepted, save it with `save_plan({kind:"weekly",
   subject:<ISO week>, content:...})` using `- [ ]` lines, respecting CORRECTIONS (e.g. no-Sunday rules).
6. File the summary: `write_brief({kind:"catch-up", subject:<since>, title:"While you were away",
   body:..., idempotencyKey:"catch-up-<since>-<nextCursor>"})`, and end the body with `cursor: <nextCursor>`.
7. Add one dated entry to `notes` with `memory` naming the follow-ups the user committed to.
