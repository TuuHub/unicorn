import { MemoryCapExceededError, MemoryConflictError, type MemoryStore } from "./memory";

// The corrections inbox: raw, dated, verbatim user feedback ("quiz 不算分",
// "stop pinging me about tutorials"), captured via the door's `remember` tool.
// Zero-LLM on the write path (ADR-0034) — the user's wording is stored as-is,
// for the client's own agent to read back via get_memory / list_corrections.
export const CORRECTIONS_DOMAIN = "corrections";
const MAX_CORRECTION_CHARS = 500;

export type CorrectionResult = "saved" | "duplicate" | "empty";

export async function recordCorrection(
  store: MemoryStore,
  text: string,
  now = new Date(),
): Promise<CorrectionResult> {
  const clipped = text.trim().replace(/\s+/g, " ").slice(0, MAX_CORRECTION_CHARS);
  if (!clipped) {
    return "empty";
  }
  // Two attempts: a concurrent write (e.g. consolidation) invalidates the first.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const note = await store.get(CORRECTIONS_DOMAIN);
    // A client can retry a tool call it didn't get a clean response for;
    // text-level dedupe absorbs the replay without needing request-id bookkeeping.
    if (note.content.includes(clipped)) {
      return "duplicate";
    }
    const lines = note.content ? note.content.split("\n") : [];
    lines.push(`- [${now.toISOString().slice(0, 10)}] ${clipped}`);
    try {
      await saveWithTrim(store, lines, note.updatedAt || undefined);
      return "saved";
    } catch (error) {
      if (error instanceof MemoryConflictError && attempt === 0) {
        continue;
      }
      throw error;
    }
  }
  throw new Error("Correction write conflicted twice.");
}

// A full inbox must never reject user input: drop the oldest corrections until the
// new one fits. Curated rules in other domains are never touched here — only the
// raw inbox forgets FIFO.
async function saveWithTrim(store: MemoryStore, lines: string[], expectedUpdatedAt?: string): Promise<void> {
  const pending = [...lines];
  while (true) {
    try {
      await store.save(CORRECTIONS_DOMAIN, pending.join("\n"), expectedUpdatedAt);
      return;
    } catch (error) {
      if (error instanceof MemoryCapExceededError && pending.length > 1) {
        pending.shift();
        continue;
      }
      throw error;
    }
  }
}
