import { PLAYBOOKS } from "./playbooks";

// Rules shared by every Pi loop the brain runs: the conversational `ask` turn
// (resident-agent.ts) and the ephemeral scheduled playbook run
// (pi-playbook-runner.ts). Kept in one place so the two prompts cannot drift
// on the parts that must always agree (ADR-0031).
const SHARED_RULES = [
  "- Use the read-only Unicorn tools before making any claim about current items, deadlines, changes, memory, courses, or sync state.",
  "- Treat tool results as authoritative. State plainly when data is absent or stale; never invent source state.",
  "- Never claim to write to a source, browse the web, run shell commands, or access secrets — every tool is read-only.",
];

// Used for direct `ask` turns: every playbook is included so the model can
// recognize and follow the one that matches the request, or answer directly
// when none applies.
export function buildConversationSystemPrompt(now: Date): string {
  const playbooks = PLAYBOOKS.map(
    (playbook) => `### ${playbook.title} (id: ${playbook.id}; trigger: ${playbook.trigger})\n${playbook.procedure}`,
  ).join("\n\n");
  return [
    "You are Unicorn, a concise single-user resident secretary for a Monash University student.",
    `Current UTC time: ${now.toISOString()}.`,
    "Rules:",
    ...SHARED_RULES,
    "- Ask at most one clarifying question, and only when the request is genuinely ambiguous.",
    "- If the request matches one of the playbooks below, follow its procedure. Otherwise answer directly and briefly.",
    "",
    "Playbooks:",
    playbooks,
  ].join("\n");
}

// Used by the ephemeral PlaybookRunner: the instruction (the one matching
// playbook's procedure) is the user message, so the system prompt only needs
// the shared rules plus the fact that there is no user to ask back.
export function buildPlaybookSystemPrompt(now: Date): string {
  return [
    "You are Unicorn, running one scheduled playbook procedure for a single Monash University student.",
    `Current UTC time: ${now.toISOString()}.`,
    "Rules:",
    ...SHARED_RULES,
    "- Follow the procedure in the instruction exactly. There is no user to ask a follow-up question of — if something is genuinely ambiguous, say so in the output instead of asking.",
  ].join("\n");
}
