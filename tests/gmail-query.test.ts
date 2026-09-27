import { describe, expect, it } from "vitest";
import {
  buildGmailQuery,
  defaultUniversityDomains,
  loadKnownCourseCodes,
  registrableDomain,
  withGmailQuery,
} from "../src/plugins/gmail-query";
import type { PluginManifestHttp, PluginManifestMcp } from "../src/plugins/declarative/plugin";
import gmailPreset from "../src/plugins/presets/gmail.json";

describe("buildGmailQuery", () => {
  it("is just the time window when every list is empty", () => {
    expect(buildGmailQuery({ domains: [], courseCodes: [], allowlist: [], windowDays: 14 })).toBe("newer_than:14d");
  });

  it("ORs domains, course codes, and allowlist together inside one group", () => {
    const query = buildGmailQuery({
      domains: ["monash.edu", "student.monash.edu"],
      courseCodes: ["FIT2004"],
      allowlist: ["unit-convenor@example.edu"],
      windowDays: 14,
    });

    expect(query).toBe(
      "newer_than:14d ((from:monash.edu OR from:student.monash.edu) OR FIT2004 OR from:unit-convenor@example.edu)",
    );
  });

  it("skips the group() wrapper for a single-entry clause", () => {
    const query = buildGmailQuery({ domains: ["monash.edu"], courseCodes: [], allowlist: [], windowDays: 14 });

    expect(query).toBe("newer_than:14d from:monash.edu");
  });

  it("uses a custom window", () => {
    expect(buildGmailQuery({ domains: [], courseCodes: [], allowlist: [], windowDays: 30 })).toBe("newer_than:30d");
  });

  it("falls back to 14 days for a zero, negative, or non-integer window", () => {
    expect(buildGmailQuery({ domains: [], courseCodes: [], allowlist: [], windowDays: 0 })).toBe("newer_than:14d");
    expect(buildGmailQuery({ domains: [], courseCodes: [], allowlist: [], windowDays: -5 })).toBe("newer_than:14d");
    expect(buildGmailQuery({ domains: [], courseCodes: [], allowlist: [], windowDays: 3.5 })).toBe("newer_than:14d");
  });

  it("strips search-operator and quoting characters from free-text input rather than escaping them", () => {
    const query = buildGmailQuery({
      domains: ['monash.edu" OR from:evil.com'],
      courseCodes: [],
      allowlist: [],
      windowDays: 14,
    });

    expect(query).toBe("newer_than:14d from:monash.eduORfromevil.com");
  });

  it("drops an entry that becomes empty after sanitization", () => {
    const query = buildGmailQuery({ domains: ["   ", "()"], courseCodes: [], allowlist: [], windowDays: 14 });

    expect(query).toBe("newer_than:14d");
  });

  it("de-duplicates entries after sanitization", () => {
    const query = buildGmailQuery({ domains: ["monash.edu", "monash.edu"], courseCodes: [], allowlist: [], windowDays: 14 });

    expect(query).toBe("newer_than:14d from:monash.edu");
  });
});

describe("registrableDomain", () => {
  it("takes the last two labels", () => {
    expect(registrableDomain("learning.monash.edu")).toBe("monash.edu");
    expect(registrableDomain("monash.edu")).toBe("monash.edu");
  });

  it("returns null for a bare hostname with no dot", () => {
    expect(registrableDomain("localhost")).toBeNull();
  });
});

describe("defaultUniversityDomains", () => {
  it("prefers Moodle's domain first", () => {
    expect(defaultUniversityDomains(["https://learning.monash.edu", undefined])).toEqual(["monash.edu"]);
  });

  it("adds Canvas's domain when it isn't a shared instructure.com host", () => {
    expect(defaultUniversityDomains(["https://learning.monash.edu", "https://canvas.myschool.edu"])).toEqual([
      "monash.edu",
      "myschool.edu",
    ]);
  });

  it("excludes a shared instructure.com Canvas host", () => {
    expect(defaultUniversityDomains(["https://learning.monash.edu", "https://myschool.instructure.com"])).toEqual(["monash.edu"]);
  });

  it("tolerates a malformed base URL by contributing nothing for it", () => {
    expect(defaultUniversityDomains(["not a url", "https://learning.monash.edu"])).toEqual(["monash.edu"]);
  });

  it("returns an empty list when nothing is configured", () => {
    expect(defaultUniversityDomains([undefined, undefined])).toEqual([]);
  });

  it("de-duplicates when Moodle and Canvas resolve to the same domain", () => {
    expect(defaultUniversityDomains(["https://learning.monash.edu", "https://portal.monash.edu"])).toEqual(["monash.edu"]);
  });
});

describe("withGmailQuery", () => {
  it("clones the manifest and overrides only the transport query argument", () => {
    const manifest = gmailPreset as PluginManifestMcp;
    const updated = withGmailQuery(manifest, "newer_than:30d from:monash.edu");

    expect(updated.transport.arguments).toEqual({ query: "newer_than:30d from:monash.edu", pageSize: 50 });
    // The stored preset (installed manifest) is untouched.
    expect((gmailPreset as PluginManifestMcp).transport.arguments?.query).toBe("newer_than:14d");
    expect(updated).not.toBe(manifest);
  });

  it("throws for a non-mcp-transport manifest", () => {
    const httpManifest: PluginManifestHttp = {
      version: 1,
      id: "some-http-source",
      name: "Some HTTP source",
      format: "json",
      url: "https://example.com/feed.json",
      mapping: { id: { path: "id" }, kind: { value: "email" }, title: { path: "title" }, timestamp: { path: "date" } },
    };

    expect(() => withGmailQuery(httpManifest, "newer_than:14d")).toThrow(/mcp-transport/);
  });
});

describe("loadKnownCourseCodes", () => {
  it("returns every distinct, normalized course code across course-identity facets, sorted", async () => {
    const db = fakeFacetsDb([
      { data_json: JSON.stringify({ code: "fit2004" }) },
      { data_json: JSON.stringify({ code: "FIT2004" }) }, // duplicate after normalizing
      { data_json: JSON.stringify({ code: "cse1010" }) },
      { data_json: JSON.stringify({ code: null }) },
      { data_json: JSON.stringify({ code: "not a code" }) },
    ]);

    expect(await loadKnownCourseCodes(db)).toEqual(["CSE1010", "FIT2004"]);
  });

  it("returns an empty list when there are no course-identity facets", async () => {
    expect(await loadKnownCourseCodes(fakeFacetsDb([]))).toEqual([]);
  });
});

function fakeFacetsDb(rows: Array<{ data_json: string }>): D1Database {
  return {
    prepare: (sql: string) => ({
      all: async () => {
        if (sql.includes("FROM facets")) {
          return { results: rows.map((row) => ({ code: JSON.parse(row.data_json).code ?? null })) };
        }
        throw new Error(`fakeFacetsDb: unexpected all() for ${sql}`);
      },
    }),
  } as unknown as D1Database;
}
