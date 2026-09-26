// Type declarations for bridge.js — see that file for behavior notes,
// including the invented hostCapabilities.experimental.{messages,
// updateModelContext} convention this pends on upstream spec clarity.
// Kept by hand (the .js is the runtime source of truth, inlined verbatim into
// widget HTML by scripts/build-widgets.mjs); update both together.

export interface HostCapabilitiesExperimental {
  messages?: boolean;
  updateModelContext?: boolean;
  [key: string]: unknown;
}

export interface HostCapabilities {
  experimental?: HostCapabilitiesExperimental;
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
