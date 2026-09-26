// Compat shim. src/playbooks.ts (generated from playbooks/*.md by
// scripts/build-playbooks.mjs) is the source of truth now — see that script's
// header comment for why the split exists. This file exists only so the
// remaining src/agent/* consumers (prompt.ts, pi-playbook-runner.ts; the whole
// directory is being removed under ADR-0034 by a parallel change) keep
// compiling until that removal lands. Delete this file along with the rest of
// src/agent/ — do not add new imports of it.
export { PLAYBOOKS, type Playbook, type PlaybookId, type PlaybookArgument } from "../playbooks";
