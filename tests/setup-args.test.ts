import { describe, expect, it } from "vitest";
// @ts-expect-error — plain JS installer script, no type declarations.
import { KNOWN_SOURCES, parseArgs, parseSourceList, resolveTimezone } from "../scripts/setup.mjs";

describe("parseSourceList", () => {
  it("dedupes, lowercases, and orders by KNOWN_SOURCES", () => {
    expect(parseSourceList("Canvas, ed, canvas")).toEqual(["ed", "canvas"]);
  });

  it("accepts whitespace as a separator too", () => {
    expect(parseSourceList("ed moodle\ncanvas")).toEqual(["ed", "moodle", "canvas"]);
  });

  it("returns an empty list for blank input", () => {
    expect(parseSourceList("   ")).toEqual([]);
  });

  it("throws naming every unknown source at once", () => {
    expect(() => parseSourceList("ed,dropbox,slack")).toThrow(/dropbox, slack/);
  });
});

describe("parseArgs", () => {
  it("defaults to no sources selected and interactive mode", () => {
    expect(parseArgs([], {})).toEqual({ sources: null, yes: false, workerUrl: null, timezone: null });
  });

  it("parses --sources as a space-separated pair of args", () => {
    expect(parseArgs(["--sources", "ed,canvas"], {})).toMatchObject({ sources: ["ed", "canvas"] });
  });

  it("parses --sources=... as one inline argument", () => {
    expect(parseArgs(["--sources=ed,canvas"], {})).toMatchObject({ sources: ["ed", "canvas"] });
  });

  it("parses --yes and its -y short form", () => {
    expect(parseArgs(["--yes"], {})).toMatchObject({ yes: true });
    expect(parseArgs(["-y"], {})).toMatchObject({ yes: true });
  });

  it("parses --worker-url and --timezone, inline or space-separated", () => {
    expect(parseArgs(["--worker-url=https://unicorn.example.workers.dev", "--timezone", "Asia/Tokyo"], {})).toMatchObject({
      workerUrl: "https://unicorn.example.workers.dev",
      timezone: "Asia/Tokyo",
    });
  });

  it("falls back to SETUP_SOURCES / SETUP_YES / SETUP_WORKER_URL / SETUP_TIMEZONE env vars", () => {
    const options = parseArgs([], {
      SETUP_SOURCES: "ed,gmail",
      SETUP_YES: "true",
      SETUP_WORKER_URL: "https://unicorn.example.workers.dev",
      SETUP_TIMEZONE: "Asia/Tokyo",
    });

    expect(options).toEqual({
      sources: ["ed", "gmail"],
      yes: true,
      workerUrl: "https://unicorn.example.workers.dev",
      timezone: "Asia/Tokyo",
    });
  });

  it("lets an explicit flag override its env-var fallback", () => {
    const options = parseArgs(["--sources=canvas", "--timezone=UTC"], {
      SETUP_SOURCES: "ed,gmail",
      SETUP_TIMEZONE: "Asia/Tokyo",
    });

    expect(options).toMatchObject({ sources: ["canvas"], timezone: "UTC" });
  });

  it("accepts SETUP_YES spellings 1/true/yes/y, case-insensitively, and rejects anything else", () => {
    for (const value of ["1", "true", "TRUE", "yes", "y"]) {
      expect(parseArgs([], { SETUP_YES: value }).yes).toBe(true);
    }
    for (const value of ["0", "false", "no", ""]) {
      expect(parseArgs([], { SETUP_YES: value }).yes).toBe(false);
    }
  });

  it("ignores unrecognized flags rather than throwing", () => {
    expect(() => parseArgs(["--some-other-tool-flag", "value"], {})).not.toThrow();
  });

  it("throws for an invalid source passed via --sources", () => {
    expect(() => parseArgs(["--sources=ed,not-a-source"], {})).toThrow(/Unknown source/);
  });
});

describe("resolveTimezone", () => {
  it("returns the explicit override untouched", () => {
    expect(resolveTimezone("Australia/Melbourne")).toBe("Australia/Melbourne");
  });

  it("falls back to a non-empty IANA zone when nothing is given", () => {
    const zone = resolveTimezone(null);
    expect(typeof zone).toBe("string");
    expect(zone.length).toBeGreaterThan(0);
  });
});

describe("KNOWN_SOURCES", () => {
  it("is exactly the four ADR-0038 sources", () => {
    expect(KNOWN_SOURCES).toEqual(["ed", "moodle", "canvas", "gmail"]);
  });
});
