import { describe, expect, it } from "vitest";
import { clientLabel, clientMark, sourceMark, sourceTile } from "../src/marks";

describe("client marks", () => {
  it("recognises the AI apps that call unicorn by their self-registered names", () => {
    expect(clientMark("Claude").id).toBe("claude");
    expect(clientMark("claude-ai").id).toBe("claude");
    expect(clientMark("Claude Code").id).toBe("claude-code");
    expect(clientMark("ChatGPT").id).toBe("chatgpt");
    expect(clientMark("Codex CLI").id).toBe("codex");
    expect(clientMark("Cursor").id).toBe("cursor");
    expect(clientMark("Visual Studio Code").id).toBe("vscode");
    expect(clientMark("mcp_token").id).toBe("token");
    expect(clientMark("my-script").id).toBe("other");
  });

  it("escapes a client's own name and falls back to a monogram", () => {
    const html = clientLabel('<img src=x onerror="1">');
    expect(html).not.toContain("<img");
    expect(html).toContain("tile-mark sm mono");
  });

  it("maps source ids to the landing page's hues", () => {
    expect(sourceMark("campus-moodle")?.hue).toBe("#ff5a4f");
    expect(sourceMark("Ed")?.name).toBe("Ed");
    expect(sourceTile("campus-canvas")).toContain("--hue:#5fd47a");
  });
});
