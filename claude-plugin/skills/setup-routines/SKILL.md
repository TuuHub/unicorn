---
name: unicorn-setup-routines
description: Use when the user wants to set up unicorn's four scheduled routines (weekly-plan, decompose-assignment, forum-brief, triage) in Claude Code or Cowork, or asks how to automate the unicorn playbooks. Walks through adding the unicorn Worker as a claude.ai connector and creating each routine.
---
Goal: get the four unicorn playbooks running on a schedule in the user's own harness, without unicorn
itself running any code — the harness's scheduler calls the door as a claude.ai connector.

Why a connector, not this session's own MCP config: a Claude Code **routine** runs as a fresh cloud
session with no access to this machine or its local `.mcp.json` (the plugin's `url`/`token` userConfig
only applies to sessions running on this machine). A routine can only reach unicorn through a connector
added to the user's claude.ai account. The same is true for Cowork's scheduled tasks.

Tell the user exactly what to click or type — do not skip a step because it "should be automatic". If a
step below can be done conversationally (typing `/schedule ...`), say so and offer to run it; if a step
can only be done by hand in a browser (adding the connector, since that needs an OAuth consent screen this
session cannot click through), say exactly where to go and what to enter, then wait for confirmation before
moving on.

## 1. Add unicorn as a claude.ai connector (one-time, manual)

This step needs the user's browser — do it yourself only if you are already driving one on their behalf
with their explicit go-ahead; otherwise tell them to do it and wait.

1. Open **claude.ai/customize/connectors**.
2. Click **Add connector** (or **Add more**).
3. Enter the connector URL: `<the unicorn Worker's base URL>/mcp` — the same base URL configured in this
   plugin's `url` setting, e.g. `https://unicorn.<you>.workers.dev/mcp`.
4. claude.ai starts an OAuth flow against the Worker (ADR-0035's OAuth authorization server). Approve it;
   for a single-user deploy, the consent screen's login is the Worker's `ADMIN_TOKEN`. If the connector
   instead offers only a bearer-token field with no OAuth redirect, the Worker's OAuth server hasn't been
   deployed yet — tell the user to redeploy after upgrading, then retry this step.
5. Confirm the connector shows as connected before moving to section 2.

If the user only has Claude Code's local MCP config (this plugin's `.mcp.json`) and no claude.ai account
with connectors, routines cannot reach unicorn — say so plainly rather than creating a routine that will
fail every run.

## 2. Create the four routines

Each routine is a **schedule trigger plus this exact prompt** — nothing else needs to be in the prompt,
because the prompt itself calls `run_playbook` (or the client just recognizes the phrasing and calls the
matching door tool/skill). Times are the user's own local time; ask if you don't already know their
timezone.

| routine | cadence | prompt |
|---|---|---|
| weekly-plan | Monday 07:30 | `Run the unicorn weekly-plan playbook.` |
| decompose-assignment | daily 08:00 | `Run the unicorn decompose-assignment playbook.` |
| forum-brief | daily 18:00 | `Run the unicorn forum-brief playbook.` |
| triage | daily 07:15 | `Run the unicorn triage playbook.` |

### From the Claude Code CLI (fastest — do this if the user is in this session)

Run `/schedule` once per routine, letting Claude Code's own wizard ask the follow-up questions. For
example:

```
/schedule every Monday at 7:30am, run the unicorn weekly-plan playbook
```

When the wizard asks for repositories, any repository works (a routine calling only the unicorn connector
doesn't touch files) — the user's own `unicorn` repo is a reasonable default if they have one. When it
asks about connectors, make sure the **unicorn** connector from section 1 is included; routines include
every connected connector by default, so this is usually already checked. Repeat for all four routines
with their cadences and prompts from the table above.

### From claude.ai/code/routines or the Desktop app (equivalent, browser-driven)

1. Open **claude.ai/code/routines** (or, in the Desktop app's Code tab, **Routines → New routine → Cloud**).
2. Click **New routine**, paste the exact prompt from the table, pick **Schedule** as the trigger with the
   cadence from the table, and under **Connectors** confirm **unicorn** is included.
3. Click **Create**. Repeat for the remaining three.

### From Cowork's Schedule tab (if the user runs Cowork instead of Claude Code)

1. Open Cowork, go to the **Schedule** tab, and click **New Task** (or type `/schedule` inside a task).
2. Name it (for example "unicorn weekly-plan"), paste the exact prompt from the table, and set the
   cadence — Cowork's presets are hourly/daily/weekly/weekdays, so pick the closest match to the table
   (daily for the three daily routines; weekly, landing on Monday, for weekly-plan) and note in the task
   description if the exact time drifts from the table.
3. Make sure the unicorn connector (section 1) is enabled for the task.
4. Repeat for the remaining three.

## 3. Verify

After creating all four, tell the user to check `claude.ai/code/routines` (or Cowork's Schedule tab) lists
all four with the unicorn connector attached, and offer to run one now (**Run now** / "run it now") so they
see a brief show up via `get_briefs` before waiting for the real schedule.
