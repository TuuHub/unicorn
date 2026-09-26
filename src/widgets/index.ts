// The door agent's whole surface onto this module (ADR-0037): WIDGETS for the
// static facts, registerWidgetResources to publish them on an McpServer, and
// widgetToolMeta for the _meta a tool definition attaches to point at one.
//
// Everything here is generated-file plumbing on purpose — the actual widgets
// live in src/widgets/*.html and get inlined into src/widgets.generated.ts by
// scripts/build-widgets.mjs (`npm run widgets:build`); this file never reads
// the filesystem.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WIDGET_URIS } from "../mcp/door-contracts";
import { WIDGET_HTML, type WidgetName } from "../widgets.generated";

export type { WidgetName };

// Per the MCP Apps extension (SEP-1865): a UI resource is served with this
// mimeType so a host knows to render it in a sandboxed frame instead of
// showing it as plain text.
export const WIDGET_RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";

export interface WidgetDef {
  uri: string;
  html: string;
  title: string;
}

const TITLES: Record<WidgetName, string> = {
  briefCard: "Briefs",
  courseView: "Course",
  changesFeed: "Changes",
  planChecklist: "Plan",
  deadlineTimeline: "Deadlines",
  connectionStatus: "Connections",
};

export const WIDGETS: Record<WidgetName, WidgetDef> = Object.fromEntries(
  (Object.keys(WIDGET_URIS) as WidgetName[]).map((name) => [
    name,
    { uri: WIDGET_URIS[name], html: WIDGET_HTML[name], title: TITLES[name] },
  ]),
) as Record<WidgetName, WidgetDef>;

// Registers all six widgets as MCP resources. No external domain is ever
// reachable from inside them (ADR-0037): csp.*Domains stay empty, so the
// sandboxed frame cannot load or connect to anything unicorn didn't inline.
export function registerWidgetResources(server: McpServer): void {
  for (const name of Object.keys(WIDGETS) as WidgetName[]) {
    const widget = WIDGETS[name];
    server.registerResource(
      name,
      widget.uri,
      {
        title: widget.title,
        mimeType: WIDGET_RESOURCE_MIME_TYPE,
        _meta: {
          ui: {
            csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] },
            prefersBorder: true,
          },
        },
      },
      async () => ({
        contents: [{ uri: widget.uri, mimeType: WIDGET_RESOURCE_MIME_TYPE, text: widget.html }],
      }),
    );
  }
}

// The _meta a tool definition carries to point at its widget: the standard
// MCP Apps field, plus ChatGPT's pre-extension `openai/outputTemplate` alias
// so the same tool renders under either host (see src/widgets/bridge.js's
// header comment for how the two hosts differ once the view is running).
export function widgetToolMeta(name: WidgetName): Record<string, unknown> {
  const widget = WIDGETS[name];
  return {
    ui: { resourceUri: widget.uri, visibility: ["model", "app"] },
    "openai/outputTemplate": widget.uri,
  };
}
