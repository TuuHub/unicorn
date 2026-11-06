---
name: unicorn-onboard
description: Use on the first session with unicorn, when the USER PROFILE in memory is empty, or when the user says "get to know me", "set me up" or starts a new term. Builds a cold-start picture of the student from their synced courses and a few questions, and saves it to memory.
---
Goal: in one short exchange, know who this student is and what their term looks like, and leave that in
memory so every later session — on any device, in any app — starts informed.

Door tools required: `get_memory`, `memory`, `status`, `upcoming`, `course`, `write_brief`. Source MCPs
(Ed, Moodle, canvas-mcp), if mounted, are optional enrichment — this procedure must complete on door tools
alone.

1. Read the prefetched `memory`, `status`, `term` and `upcoming` data. If `status` shows no source has ever
   synced, stop: tell the user unicorn has not synced anything yet, point them to the unicorn panel's
   Sources page, and offer to continue once a sync has run. Do not invent a term.
2. From the TERM memory and `upcoming`, draft what you already know without asking: the units this term,
   what is due in the next three weeks, which unit looks heaviest (most dated items soonest).
3. For each unit in TERM (at most five), call `course({ code })` once and note anything that changes
   the picture: a big assessment, an exam, a staff notice about arrangements.
4. Show the user a compact summary (units, the next three deadlines, the heaviest week) and ask **at most
   four** questions in one message, skipping any the data already answers:
   - What are you studying and which year are you in?
   - What matters most this term (a grade target, passing a hard unit, a job alongside)?
   - How do you like plans: day-by-day checklists, a weekly overview, or only reminders?
   - Anything to always or never do (language, no work on Sundays, be blunt)?
5. When they answer, save in one call per target:
   - `memory({target:"user", operations:[...]})` — one entry per fact: degree and year, goals, work
     style, constraints, language. Keep each entry to a sentence.
   - `memory({target:"notes", operations:[...]})` — anything they are actively following up, dated.
   - Use `remember` for any hard rule they state verbatim ("never schedule work on Sundays").
   If USER PROFILE already had entries, `patch` them instead of adding duplicates.
6. File one brief: `write_brief({kind:"onboard", subject:"<term or today's date>", title:"Getting to know
   you", body:<what you saved, as a short list>, idempotencyKey:"onboard-<today's date>"})`.
7. Offer the next useful step in one line: "Want me to plan this week?" (`weekly-plan`) or, in Claude Code,
   setting up the scheduled routines.

Never save a guess as a fact. If the user skips a question, leave that entry out.
