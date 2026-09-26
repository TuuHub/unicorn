// Pure prompt/summary builders shared by every widget (ADR-0037 scope
// addition: widgets as a collaborative surface, not just display).
//
// Two families:
//   - "ask" prompts: handed to the model via bridge.sendMessage() as if the
//     user typed them ("Discuss this", "Break this down", ...). Always name
//     the concrete source:itemId (or brief id, plan subject, ...) so the
//     model's next tool call is precise rather than "which one did they mean".
//   - context summaries: handed to bridge.updateModelContext() after a widget
//     action (ack, checklist toggle) so the model's next turn already knows
//     what happened without re-calling a door tool.
//
// Every function here is pure — no bridge, no DOM — so widgets and tests
// import the exact same string. Dual-mode module: see markdown.js's header
// for why this also runs as a plain inlined script.

export function discussBriefPrompt(brief) {
  return `Discuss the brief "${brief.title}" (id ${brief.id}, kind ${brief.kind}).`;
}

export function decomposeAssignmentPrompt(course, bucket, item) {
  return `Run the decompose-assignment playbook for ${item.source}:${item.itemId} (${course.code} — ${bucket.label}).`;
}

export function askStaffOpinionPrompt(course, bucket) {
  return `What do staff say about ${course.code} — ${bucket.label}?`;
}

export function whatMattersPrompt(changes) {
  const count = changes.events.length;
  return `What matters in these ${count} change${count === 1 ? "" : "s"} since cursor ${changes.nextCursor}?`;
}

export function planAroundPrompt(item) {
  return `Help me plan around "${item.title}" (${item.source}:${item.itemId}), due ${item.dueAt}.`;
}

export function replanRestPrompt(plan, remainingTexts) {
  const subject = plan.kind === "weekly" ? `week ${plan.subject}` : plan.subject;
  if (remainingTexts.length === 0) return `Replan ${subject} — everything is already done.`;
  const list = remainingTexts.map((text) => `- ${text}`).join("\n");
  return `Replan the rest of ${subject}. Remaining:\n${list}`;
}

export function fixSourcePrompt(source) {
  return `Help me fix ${source.label} (${source.id}): ${source.lastError}`;
}

export function ackBriefSummary(brief) {
  return `User marked the brief "${brief.title}" (id ${brief.id}) as read.`;
}

export function ackAllBriefsSummary(count) {
  return `User marked ${count} brief${count === 1 ? "" : "s"} as read.`;
}

export function checklistToggleSummary(plan, item, checkedNow, done, total) {
  const subject = plan.kind === "weekly" ? `plan ${plan.subject}` : `plan "${plan.subject}"`;
  const verb = checkedNow ? "checked" : "unchecked";
  return `User ${verb} "${item.text}" in ${subject} (${done}/${total} done).`;
}

if (typeof window !== "undefined") {
  window.Unicorn = window.Unicorn || {};
  window.Unicorn.prompts = {
    discussBriefPrompt,
    decomposeAssignmentPrompt,
    askStaffOpinionPrompt,
    whatMattersPrompt,
    planAroundPrompt,
    replanRestPrompt,
    fixSourcePrompt,
    ackBriefSummary,
    ackAllBriefsSummary,
    checklistToggleSummary,
  };
}
