# unicorn (Claude Code plugin)

Mounts your self-deployed [unicorn](https://github.com/TuuHub/unicorn) Worker's door as an MCP server,
ships the four playbooks as skills, and pulls unread briefs into every session start.

## Install

```
claude plugin marketplace add TuuHub/unicorn
claude plugin install unicorn@unicorn
```

Claude Code then asks for two values (or run `/config` later to set or change them):

- **Worker URL** — your Worker's base URL, e.g. `https://unicorn.<you>.workers.dev` (no trailing slash,
  no `/mcp`).
- **MCP token** — the `MCP_TOKEN` bearer secret your Worker was deployed with. This is stored, never
  echoed back.

Restart Claude Code (or start a new session) to pick up the new MCP server and skills.

## What's in here

| piece | file(s) | what it does |
|---|---|---|
| Door MCP server | `.mcp.json` | Mounts `<url>/mcp` over streamable HTTP with your token as a bearer header — the door tools (`get_briefs`, `course`, `changes_since`, `search_items`, `save_plan`, …) become available in every session. |
| Playbook skills | `skills/weekly-plan/`, `skills/decompose-assignment/`, `skills/forum-brief/`, `skills/triage/` | One skill per door v2 playbook, generated from this repo's `playbooks/*.md` (`npm run playbooks:build`) so the skill body is always the exact procedure `run_playbook` returns. Claude auto-triggers the matching one from a request like "plan my week" or "what did staff post"; you can also run one directly. |
| Setup skill | `skills/setup-routines/` | Hand-written walkthrough for turning the four playbooks into scheduled routines (Claude Code `/schedule`, or Cowork's Schedule tab) — the piece that can't be done from inside a session, since it needs unicorn added as a claude.ai connector first. |
| Briefs on session start | `hooks/hooks.json`, `hooks/pull-briefs.mjs` | A `SessionStart` hook that calls `get_briefs` and adds up to 5 unread titles as context, so a session starts already knowing what's new. Silent and non-blocking: a 3-second timeout, and no output at all if the plugin isn't configured yet or the Worker doesn't respond. |

## Next step

Ask Claude to "set up my unicorn routines" (triggers the `setup-routines` skill) once the plugin is
installed and configured, to get `weekly-plan`, `decompose-assignment`, `forum-brief`, and `triage`
running on their own schedule.
