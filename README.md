<p align="center"><a href="https://unicorn.tuuhub.com"><img src=".github/assets/hero.jpg" alt="unicorn: the memory layer for the AI agent you already use" width="100%"></a></p>

# 🦄 unicorn

**Give your AI agent a memory of your campus.**

unicorn reads Ed, Moodle, Canvas, Gmail and feeds every hour, and remembers what each said. Your agent can then ask what changed, see one course across every system, and keep a shared plan.

It is a remote MCP server on your own free Cloudflare account. It has no model of its own: your agent does the thinking.

[![Apache-2.0 License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

> 🦄 The memory layer of unicorn. Live tools answer what is there now; unicorn answers what changed.
>
> 📖 **[Read the docs](https://unicorn.tuuhub.com/docs/unicorn)**

## Set up

Ask your coding agent (Claude Code, Codex, or anything with a terminal) from a clone of this repository:

```text
Read https://unicorn.tuuhub.com/docs/unicorn/agent-setup.md and set up unicorn for me.
```

Or by hand:

```bash
npm run setup
```

Setup deploys the Worker to your Cloudflare account, then walks you through each source.

## Use it from

| Where | How |
| --- | --- |
| Claude, ChatGPT or any web AI | Add your Worker as a custom connector. [Connect](https://unicorn.tuuhub.com/docs/unicorn/connect) |
| Claude Code, Cowork | Add the same Worker as a remote MCP server. [Connect](https://unicorn.tuuhub.com/docs/unicorn/connect) |

## What you can ask

| Ask your agent | What unicorn gives it |
| --- | --- |
| “What changed since Tuesday?” | Every new post, deadline move and grade, in order |
| “What is due in the next week?” | Deadlines across every course and system |
| “Show me everything for UNIT.” | One course joined across Ed, Moodle and Canvas |
| “Plan my week.” | The `weekly-plan` playbook, with a plan both laptop and phone see |
| “Brief me on the forum.” | The `forum-brief` playbook |

In Claude and ChatGPT, answers can come back as cards instead of text. unicorn never writes to your sources.

## Learn more

- [Deploy](https://unicorn.tuuhub.com/docs/unicorn/deploy) and [add sources](https://unicorn.tuuhub.com/docs/unicorn/sources)
- [Connect a client](https://unicorn.tuuhub.com/docs/unicorn/connect)
- [Daily use](https://unicorn.tuuhub.com/docs/unicorn/daily-use)
- [Playbooks](https://unicorn.tuuhub.com/docs/unicorn/playbooks) and [widgets](https://unicorn.tuuhub.com/docs/unicorn/widgets)
- [Your own tools](https://unicorn.tuuhub.com/docs/unicorn/custom-tools)
- [Upgrade](https://unicorn.tuuhub.com/docs/unicorn/upgrade)
- [Security](https://unicorn.tuuhub.com/docs/unicorn/security)
- [Troubleshooting](https://unicorn.tuuhub.com/docs/unicorn/troubleshooting)
- [Tool reference](https://unicorn.tuuhub.com/docs/unicorn/reference/tools)

Working on unicorn itself? The design notes and decision records are in [docs/](docs/).

## 🦄 Part of unicorn

Live tools answer what is there now; unicorn answers what changed.

| Project | Layer | What it does |
| --- | --- | --- |
| **[🦄 unicorn](https://github.com/TuuHub/unicorn)** (you are here) | **Memory** | **Remembers your campus sources and tells your agent what changed. Remote MCP.** |
| [moodle-cli](https://github.com/bunizao/moodle-cli) | Live | Moodle. CLI, local and remote MCP. |
| [edstem-cli](https://github.com/bunizao/edstem-cli) | Live | Ed Discussion. CLI, local and remote MCP. |
| [ontrack](https://github.com/bunizao/ontrack-cli) | Live | OnTrack and Doubtfire. CLI only. |

📖 [All docs](https://unicorn.tuuhub.com/docs) · [CLIs overview](https://unicorn.tuuhub.com/cli) · [Connect an MCP client](https://unicorn.tuuhub.com/docs/mcp)

## License

Apache License 2.0. See [LICENSE](LICENSE).
