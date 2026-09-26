---
name: unicorn-triage
description: Use when the user wants unlabelled course or life items sorted into buckets, or to run the unicorn triage routine. Labels items via the door's label_items tool without guessing at ambiguous ones.
---
Goal: give every unlabelled item a bucket, and a topic when it is obvious, without ever guessing at a
course.

Door tools required: `life`, `course`, `label_items`, `write_brief`. Source MCPs, if mounted, are
optional enrichment for reading a thread or email in full when the title alone does not say enough — use
them if available, but this procedure must complete on door tools alone.

The five buckets, exactly these: `course/<CODE>/<assignment-slug>`, `course/<CODE>/general`,
`life/events`, `life/admin`, `life/other`.

1. Call `life()`. Its `unlabeled` list is your first candidate pool — non-course items nobody has
   labelled yet.
2. For every course you know about (from a `course({ code })` call earlier this session, or from the
   `course` field on any candidate item), call `course({ code })` and take its `unlabeled` list too.
3. Never touch an item whose `labeledBy` is already `"client"` — that was a deliberate human or agent
   decision; leave it alone even if you would have chosen differently. Only items with `unlabeled: true`
   and `bucket: null` are candidates.
4. For each candidate, decide:
   - If its `course` field is set and the content is clearly about one assignment (the title or snippet
     names an assessment, or it is a thread whose category matches one), bucket it
     `course/<CODE>/<assignment-slug>` — reuse the exact slug an existing bucket for that course already
     uses; never invent a second slug for the same assignment.
   - If its `course` field is set but it is general course chatter (lectures, exam logistics, nothing
     assignment-specific), bucket it `course/<CODE>/general`.
   - If it has no course and reads as a club, seminar, or career-fair style item, bucket it
     `life/events`.
   - If it has no course and reads as enrolment, fees, timetable, or an official administrative notice,
     bucket it `life/admin`.
   - Otherwise `life/other`. When you are not sure whether an item belongs to a course at all, or which
     course, choose `life/other` over guessing a course bucket — a wrong course bucket is worse than an
     honest "other".
   - Add a `topic` only when it is unambiguous from the title or snippet alone (for example "exam",
     "extension", "club", "career"). Leave it out rather than force one.
5. Call `label_items({ items: [{ source, itemId, bucket, topic? }, ...] })` once, in a single batch, for
   everything you decided in step 4. Do not call it once per item.
6. If a candidate remains genuinely ambiguous even after reading its snippet (and, if a source MCP is
   mounted, the full item there), leave it unlabelled rather than force a guess — omit it from step 5's
   batch entirely.
7. Write a brief only if something needs the user's attention: an unrecognised course code appeared
   repeatedly, or several items landed in `life/other` that look like they should belong to a course you
   know but you could not confirm which. If everything labelled cleanly with nothing left over, do not
   call `write_brief` at all.
8. When you do write one: `write_brief({ kind: "triage", subject: "<today's ISO date>", title: "Triage —
   items needing a look", body: "<what you were not sure about, and why>", idempotencyKey: "<today's ISO
   date>" })`.

When run interactively: tell the user how many items got labelled and into which buckets, in one line;
mention anything you left unlabelled and why.
