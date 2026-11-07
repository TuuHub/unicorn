---
name: unicorn-exam-prep
description: Use when the user asks to prepare for an exam, test or final in one unit, or "what should I revise for UNIT". Gathers every exam notice, staff hint and assessment in the unit and builds a revision plan up to the exam date.
---
Goal: one revision plan per exam, grounded only in what the unit's staff actually said.

Door tools required: `course`, `search_items`, `upcoming`, `get_plan`, `save_plan`, `write_brief`,
`memory`. Source MCPs (Ed lessons, Moodle resources), if mounted, are optional enrichment for reading
lecture lists and past-paper pages — use them when available, but complete on door tools alone.

1. The prefetched data has `course` (the unit, grouped by bucket), `examItems` (full-text matches for
   exam, final, test, revision, past paper in that unit) and `upcoming` for the unit. If `course` is
   ambiguous, ask which offering before going on.
2. Establish the exam facts, each with its source link: date and time, duration, format (open/closed
   book, online/in person), weighting, hurdle, allowed materials, covered weeks or topics. If a fact is
   not in the data, write "not announced" — never assume a typical value.
3. Collect every staff hint about content: posts in `course/<CODE>/general` and exam buckets where the
   author is staff, and threads asking "is X examinable". Quote the staff line briefly.
4. Build a revision plan from today to the exam: topics first by weighting or staff emphasis, then
   practice (past papers, tutorial questions), with the last two days for review. Respect other deadlines
   from `upcoming` across all units and every CORRECTIONS line.
5. Save it: `save_plan({kind:"assignment", subject:"<exam item source>:<itemId>", content:...})` when
   there is an exam item; otherwise `save_plan({kind:"weekly", subject:<ISO week>, ...})` for this week's
   slice. Use `- [ ]` lines.
6. File `write_brief({kind:"exam-prep", subject:<CODE>, title:"<CODE> exam prep", body:<facts + plan
   summary>, idempotencyKey:"exam-prep-<CODE>-<today>"})`.
7. Add to `notes` with `memory`: "<CODE> exam <date>: revision plan saved; weak topics: …" so later
   sessions can check in on it.
