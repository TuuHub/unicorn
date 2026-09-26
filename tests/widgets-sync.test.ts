import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs build script, no type declarations.
import { buildWidgets } from "../scripts/build-widgets.mjs";
import { WIDGET_HTML } from "../src/widgets.generated";
import { WIDGET_URIS } from "../src/mcp/door-contracts";

// src/widgets.generated.ts is generated (npm run widgets:build) from
// src/widgets/* — see scripts/build-widgets.mjs for why. This test rebuilds
// every widget independently and compares it against what the committed
// generated file actually exports, so an edit to src/widgets/* without a
// rerun of `npm run widgets:build` fails `npm run check` — the same pattern
// tests/playbooks-sync.test.ts uses for playbooks.ts.

const EXTERNAL_URL_RE = /\b(?:src|href|url\()\s*=?\s*["'(]?\s*(https?:)\/\//i;

describe("widgets.generated.ts sync with src/widgets/*", () => {
  const widgets = buildWidgets() as Array<{ name: string; html: string }>;

  it("has exactly the six ADR-0037 widgets, matching WIDGET_URIS", () => {
    expect(widgets.map((widget) => widget.name).sort()).toEqual(Object.keys(WIDGET_URIS).sort());
  });

  it.each(widgets.map((widget) => [widget.name, widget] as const))(
    "%s inlines to exactly what src/widgets.generated.ts exports",
    (_name, widget) => {
      expect(WIDGET_HTML[widget.name as keyof typeof WIDGET_HTML]).toBe(widget.html);
    },
  );
});

describe("every widget is fully self-contained", () => {
  const widgets = buildWidgets() as Array<{ name: string; html: string }>;

  it.each(widgets.map((widget) => [widget.name, widget] as const))(
    "%s's HTML has no external URL in a src/href/url()",
    (_name, widget) => {
      expect(widget.html).not.toMatch(EXTERNAL_URL_RE);
    },
  );
});
