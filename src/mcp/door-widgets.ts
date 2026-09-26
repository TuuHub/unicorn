// TODO(widgets): temporary adapter. Swap this import in door.ts for the real
// `../widgets/index.ts` once it lands on main (ADR-0037) — same two exports,
// same signatures, so the swap is a one-line change. Until then both
// functions are safe no-ops: no resources are registered and no tool carries
// widget _meta, so every door tool still works from its text content alone.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WIDGET_URIS } from "./door-contracts";

export type WidgetName = keyof typeof WIDGET_URIS;

export function registerWidgetResources(_server: McpServer): void {
  // no-op until src/widgets/index.ts lands on main
}

export function widgetToolMeta(_name: WidgetName): Record<string, unknown> {
  // no-op until src/widgets/index.ts lands on main
  return {};
}
