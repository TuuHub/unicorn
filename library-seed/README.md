# unicorn-tools seed library

Starter definitions for unicorn's ADR-0035 user-defined SQL tools. `index.json`
lists each tool's name, description and file path; `browse_tools`/`install_tool`
on unicorn's admin MCP server read this repo directly from
`raw.githubusercontent.com` — nothing here needs building or publishing.

## Layout

```
index.json          — { tools: [{ name, description, path }] }
tools/<name>.json    — { name, description, inputSchema, sql }
```

Each tool file is exactly `install_tool`'s `DefineToolInput` shape: it runs
through the same guard as `define_tool` (a mechanical allowlist over the five
`v_*` views — see `describe_schema`), so nothing here can define a tool that
reaches a raw table.

## Tools

| name | what it returns |
| --- | --- |
| `next_lab` | The next few upcoming items for one course, soonest deadline first. |
| `overdue` | Items with a missed deadline in the last 7 days, across every course. |
| `week_ahead` | Items due within the next N days (default 7), across every course. |
| `course_activity` | The most recent changes recorded for one course. |

## Publishing a new tool here

Use `unicorn`'s `publish_tool` admin tool: it returns the exact file content,
the `index.json` entry to add, and the `gh` commands to open a PR — unicorn
itself never writes to GitHub.

## Using a different repo

Set the `tools_repo` setting (`{"repo": "<owner>/<name>"}`) to point
`browse_tools`/`install_tool`/`publish_tool` at a fork or a private library
with this same layout.
