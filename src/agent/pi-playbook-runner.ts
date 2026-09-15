// STUB — replaced by feat/brain at merge
import type { Env } from "../runtime/cycle";
import type { PlaybookRunner } from "./playbook-runner";

export function createPlaybookRunner(_env: Env): PlaybookRunner {
  return {
    async run() {
      return { status: "skipped", reason: "not_configured" };
    },
  };
}
