// Type declarations for bridge.js — see that file for behavior notes.
// Kept by hand (the .js is the runtime source of truth, inlined verbatim into
// widget HTML by scripts/build-widgets.mjs); update both together.

// The subset of the MCP Apps HostCapabilities (ui/initialize result) we read.
export interface HostCapabilities {
  message?: object;
  updateModelContext?: object;
  [key: string]: unknown;
}

export interface OpenAIGlobal {
  sendFollowUpMessage?: (args: { prompt: string }) => unknown;
  [key: string]: unknown;
}

export interface BridgeCapabilities {
  message: boolean;
  updateModelContext: boolean;
}

export function detectCapabilities(
  hostCapabilities: HostCapabilities | null | undefined,
  openaiGlobal: OpenAIGlobal | null | undefined,
): BridgeCapabilities;

export function isTrustedMessageSource(eventSource: unknown, parentWindow: unknown): boolean;

export function isSafeLinkUrl(url: unknown): boolean;
