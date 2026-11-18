# Design system: Pearl & Ink

unicorn's panel is a quiet surface for loud information. Deadlines, changes and failures carry the color. Everything else is greyscale.

Tokens live in `:root` in `src/ui.ts`, with a dark-mode block below them. Pages use tokens and never write raw hex values. The one exception is `#17161c` on the brand mark, because the horn is light in both themes.

## Color

| Token | Light | Dark | Role |
|---|---|---|---|
| `--bg` | `#f2f2f5` | `#08080b` | Page background (pearl / night) |
| `--surface` | `#ffffff` | `#131318` | Cards and widgets |
| `--surface-2` | `#f6f6f8` | `#1a1a20` | Insets inside a card |
| `--default` | `#ebebef` | `#22222a` | Secondary buttons, chips, the current nav item |
| `--fg` | `#17161c` | `#f4f3f7` | Ink: text, primary buttons, focus ring, progress fill |
| `--muted` | `#6b6a75` | `#9a99a6` | Secondary text |
| `--faint` | `#a3a2ad` | `#6c6b78` | Link underlines, idle dots |
| `--border` | `#e3e2e8` | `#24232b` | The 1px ring every card uses as its shadow |
| `--opal` | `#14a3a8` | `#46d1d3` | Something new or changed |
| `--danger` | `#e5484d` | — | Overdue, failed, stopped |
| `--warning` | `#e8a23a` | — | Due within 48 hours |
| `--success` | `#3aa76a` | — | Handed in, done |
| `--horn` | gradient | gradient | The brand mark only |

Each signal color has `-soft` (fill) and `-text` (readable on a surface) variants.

### Rules

- **Ink is the accent.** The primary action is an ink button. A link is ink with a faint underline. There is no brand blue.
- **Color is a signal, not a decoration.** A signal color appears only when its state is true: red only when something is late or broken, amber only when it is due soon. If nothing is wrong, the page is greyscale.
- **One signal per sentence.** Never put two colored phrases side by side. When sync has stopped, that is the only red text in the subtitle.
- **Prefer small marks.** Signals show as a 6px dot, a chip, or an icon tint before they take over a whole word.
- **The horn appears once.** The iridescent gradient is the unicorn on the logo. It is never used for progress bars, lines, charts or backgrounds.

## Type

The system UI stack only. The CSP (`default-src 'none'`) blocks web fonts, and the native face reads well on every platform the panel runs on.

| Use | Size / line | Weight |
|---|---|---|
| Overview headline | 26 / 34 | 600, -0.02em |
| Page `h1` | 20 / 28 | 600, -0.01em |
| Card title `h2` | 16 / 24 | 500 |
| Body | 14 / 21 | 400 |
| Meta, timestamps | 12.5 | 400, tabular numbers |

Use sentence case everywhere. Don't use all-caps labels.

## Shape

- Radii: 16px for cards and widgets, 12px for controls and insets, 999px for chips and bars. An inner radius is never larger than its outer one.
- Depth comes from a 1px ring (`--shadow`), not from a drop shadow. The only exception is `--shadow-lg`, for floating elements such as the board's edit bar.
- Spacing steps are 4, 8, 12, 16, 24 and 40.

## Controls

- **Status dot.** 8px, traffic-light: `--success` when a thing works, `--warning` when it is degraded or stale (a failing source, a sync older than two hours), `--danger` when it is broken, a hollow faint ring when it is off or not set up. A colour never stands alone: the sentence next to it says the same thing.
- **Switch.** 40×24. Off is a `--default` track with a faint ring and a small faint knob. On is an ink track with a `--surface` knob, so it reads in both themes. On the server it is a `<button role="switch" aria-checked>` inside a form, because the CSP allows no fetch.
- **Destructive actions** are quiet text buttons in `--danger-text` that confirm first. They never get a red fill until hovered.
- **Ask chip.** A line to say to the user's agent, with a spark icon. Clicking opens a menu: open it as a new chat in Claude or ChatGPT, or copy it. unicorn has no agent of its own, so empty states that the agent fills (plans, profile) offer the line that fills them instead of explaining how.
- **Optical alignment.** Columns of values share one grid so they start on the same line. An icon-only button at a card's edge takes a negative margin so its glyph, not its hit area, lines up with the content.
- **Errors sit where they happened.** A form that fails puts its message inside its own card and scrolls there, not only at the top of the page.
- **Inline edit.** A list the user can correct (memory entries) shows plain rows. Clicking a row swaps it for a textarea in place, with Delete, Cancel and Save. ⌘↩ saves and Escape cancels. Delete doesn't confirm, because the change lands in a feed with Undo.
- **Confirmations are toasts.** "Saved", "Removed Ed" and the like float in at the bottom right, show for four seconds and leave. The flag that triggered one is dropped from the address so a reload doesn't repeat it.
- **A result answers where it was asked.** Test connection, an Okta sign-in and other per-card actions show their outcome inside that card, with a dot, and the page scrolls back to it. Toasts are only for page-wide confirmations.

## Motion

The design skills in `.agents/skills` (from `../site`) set the rules; these are the ones the panel uses.

- Two curves, both tokens in `:root`: `--ease-out` (`cubic-bezier(.23,1,.32,1)`) for anything entering or responding to a press, `--ease-in-out` for movement on screen. Never `ease-in`, never `transition: all`.
- Under 300ms. Press feedback 160ms, menus 160ms, reveals 200ms, toasts 260ms in and 200ms out. Rearranging the board (resize, move, add, hide) glides each widget with a 240ms view transition on `--ease-out`.
- Buttons scale to `.96` on press. The switch knob slides as its form submits.
- Menus scale from `.97` at their trigger. `<details>` content fades down 4px.
- Charts grow once on load, staggered 30–40ms per bar. Nothing else animates on load.
- Nothing that happens tens of times a minute animates: hovers change color only.
- Under `prefers-reduced-motion` everything stops except the toast, which fades instead of sliding so it still leaves.

## Overview board

The overview is a grid of widgets the user can rearrange. The code is in `src/panel-board.ts`.

- Three columns. A widget is `s` (one column), `m` (two columns) or `l` (full width). Tablets (≤1100px) get two columns, and phones (≤640px) get one.
- The layout is saved in the `settings` table as one JSON row with the key `overview_board`. It is saved with a plain form POST to `/panel/board`, because the CSP allows no `fetch`.
- Every widget is rendered on the server. Hidden widgets carry the `hidden` attribute. Customizing toggles them in place, and nothing is fetched.
- The headline above the board is a single sentence saying what needs attention next. It is the most useful line on the page, so no widget repeats it.
- Below the headline, once an agent is connected, up to three ask chips suggest the next useful playbook, picked from what the board shows.
- The setup checklist appears only while setup is incomplete. On phones it shows only the unfinished steps.
