import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildSourcePlugins,
  buildSourceStatuses,
  D1SourceCredentialStore,
  decryptFields,
  encryptFields,
  isSourceId,
  itemCountsByPlugin,
  nonSecretPrefill,
  presetFor,
  resolveCanvasCredentials,
  resolveEdCredentials,
  resolveMoodleCredentials,
  SOURCE_IDS,
  testSource,
  type CredentialLookup,
  type SourceEnv,
} from "../src/sources";

describe("presetFor / isSourceId", () => {
  it("returns the matching preset for every known id", () => {
    for (const id of SOURCE_IDS) {
      expect(presetFor(id).id).toBe(id);
    }
  });

  it("throws for an id outside the registry", () => {
    expect(() => presetFor("not-a-source" as never)).toThrow(/Unknown source id/);
  });

  it("isSourceId accepts only the four registered ids", () => {
    expect(isSourceId("ed")).toBe(true);
    expect(isSourceId("gmail")).toBe(true);
    expect(isSourceId("dropbox")).toBe(false);
    expect(isSourceId("")).toBe(false);
  });
});

describe("encryptFields / decryptFields", () => {
  it("round-trips arbitrary field data", async () => {
    const fields = { token: "abc123", region: "au" };
    const encrypted = await encryptFields(fields, "admin-secret");

    expect(await decryptFields(encrypted, "admin-secret")).toEqual(fields);
  });

  it("uses a fresh random IV each time, so the same plaintext never produces the same ciphertext twice", async () => {
    const a = await encryptFields({ token: "same" }, "admin-secret");
    const b = await encryptFields({ token: "same" }, "admin-secret");

    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it("fails to decrypt with the wrong key (ADMIN_TOKEN rotated)", async () => {
    const encrypted = await encryptFields({ token: "abc123" }, "admin-secret");

    expect(await decryptFields(encrypted, "a-different-secret")).toBeNull();
  });

  it("fails to decrypt when the ciphertext has been tampered with", async () => {
    const encrypted = await encryptFields({ token: "abc123" }, "admin-secret");
    const tampered = { ...encrypted, ciphertext: flipLastByte(encrypted.ciphertext) };

    expect(await decryptFields(tampered, "admin-secret")).toBeNull();
  });

  it("fails to decrypt when the iv has been tampered with", async () => {
    const encrypted = await encryptFields({ token: "abc123" }, "admin-secret");
    const tampered = { ...encrypted, iv: flipLastByte(encrypted.iv) };

    expect(await decryptFields(tampered, "admin-secret")).toBeNull();
  });

  it("never throws on garbage input", async () => {
    await expect(decryptFields({ ciphertext: "not-base64!!", iv: "also-not-base64!!" }, "admin-secret")).resolves.toBeNull();
  });
});

describe("D1SourceCredentialStore", () => {
  it("reports 'none' when nothing is stored", async () => {
    const store = new D1SourceCredentialStore(fakeDb(), "admin-secret");

    expect(await store.get("ed")).toEqual({ status: "none" });
  });

  it("saves, encrypts, and reads back the same fields", async () => {
    const db = fakeDb();
    const store = new D1SourceCredentialStore(db, "admin-secret");

    await store.save("canvas", { baseUrl: "https://school.instructure.com", token: "t-123" });
    const lookup = await store.get("canvas");

    expect(lookup).toEqual({ status: "ok", fields: { baseUrl: "https://school.instructure.com", token: "t-123" } });
    // Never stored as plaintext.
    const raw = db.rows.get("canvas");
    expect(raw?.ciphertext).not.toContain("t-123");
  });

  it("reports 'invalid' for a row that no longer decrypts under the current ADMIN_TOKEN", async () => {
    const db = fakeDb();
    await new D1SourceCredentialStore(db, "old-admin-secret").save("ed", { token: "abc" });

    const rotated = new D1SourceCredentialStore(db, "new-admin-secret");
    expect(await rotated.get("ed")).toEqual({ status: "invalid" });
  });

  it("overwrites an existing row on a second save", async () => {
    const db = fakeDb();
    const store = new D1SourceCredentialStore(db, "admin-secret");

    await store.save("ed", { token: "first" });
    await store.save("ed", { token: "second" });

    expect(await store.get("ed")).toEqual({ status: "ok", fields: { token: "second" } });
    expect(db.rows.size).toBe(1);
  });

  it("delete removes the row", async () => {
    const db = fakeDb();
    const store = new D1SourceCredentialStore(db, "admin-secret");

    await store.save("moodle", { session: "s" });
    await store.delete("moodle");

    expect(await store.get("moodle")).toEqual({ status: "none" });
  });
});

describe("credential resolution precedence", () => {
  describe("resolveEdCredentials", () => {
    it("prefers the env secret over a stored token", () => {
      const options = resolveEdCredentials(sourceEnv({ ED_API_TOKEN: "env-token" }), ok({ token: "stored-token", region: "eu" }));

      expect(options?.token).toBe("env-token");
    });

    it("falls back to the stored token when no env secret is set", () => {
      const options = resolveEdCredentials(sourceEnv(), ok({ token: "stored-token", region: "eu" }));

      expect(options).toEqual({ token: "stored-token", region: "eu" });
    });

    it("returns null when neither is configured", () => {
      expect(resolveEdCredentials(sourceEnv(), none())).toBeNull();
    });

    it("defaults region to us when not stored", () => {
      const options = resolveEdCredentials(sourceEnv({ ED_API_TOKEN: "env-token" }), none());

      expect(options?.region).toBe("us");
    });
  });

  describe("resolveMoodleCredentials", () => {
    it("prefers the env session secret over a stored one", () => {
      const options = resolveMoodleCredentials(sourceEnv({ MOODLE_SESSION: "env-session" }), ok({ session: "stored-session" }));

      expect(options?.session).toBe("env-session");
    });

    it("lets a stored baseUrl override the shipped MOODLE_BASE_URL default", () => {
      const options = resolveMoodleCredentials(
        sourceEnv({ MOODLE_SESSION: "env-session" }),
        ok({ baseUrl: "https://learning.otherschool.edu" }),
      );

      expect(options?.baseUrl).toBe("https://learning.otherschool.edu");
    });

    it("falls back to the shipped MOODLE_BASE_URL when nothing is stored", () => {
      const options = resolveMoodleCredentials(sourceEnv({ MOODLE_SESSION: "env-session" }), none());

      expect(options?.baseUrl).toBe("https://learning.monash.edu");
    });

    it("returns null when no session is configured on either side", () => {
      expect(resolveMoodleCredentials(sourceEnv(), none())).toBeNull();
      expect(resolveMoodleCredentials(sourceEnv(), ok({ baseUrl: "https://x.edu" }))).toBeNull();
    });
  });

  describe("resolveCanvasCredentials", () => {
    it("prefers env secrets for both token and baseUrl", () => {
      const options = resolveCanvasCredentials(
        sourceEnv({ PLUGIN_SECRET_CANVAS_TOKEN: "env-token", CANVAS_BASE_URL: "https://env.instructure.com" }),
        ok({ token: "stored-token", baseUrl: "https://stored.instructure.com" }),
      );

      expect(options).toEqual({ token: "env-token", baseUrl: "https://env.instructure.com" });
    });

    it("falls back to stored fields when no env secrets are set", () => {
      const options = resolveCanvasCredentials(sourceEnv(), ok({ token: "stored-token", baseUrl: "https://stored.instructure.com" }));

      expect(options).toEqual({ token: "stored-token", baseUrl: "https://stored.instructure.com" });
    });

    it("returns null unless both a token and a baseUrl are available", () => {
      expect(resolveCanvasCredentials(sourceEnv(), ok({ token: "only-token" }))).toBeNull();
      expect(resolveCanvasCredentials(sourceEnv(), ok({ baseUrl: "https://only.instructure.com" }))).toBeNull();
      expect(resolveCanvasCredentials(sourceEnv(), none())).toBeNull();
    });
  });
});

describe("nonSecretPrefill", () => {
  it("never includes a secret field for any source", async () => {
    const edFields = nonSecretPrefill("ed", sourceEnv({ ED_API_TOKEN: "env-token" }), ok({ token: "super-secret", region: "au" }));
    expect(edFields).toEqual({ region: "au" });
    expect(JSON.stringify(edFields)).not.toContain("super-secret");

    const moodleFields = nonSecretPrefill("moodle", sourceEnv(), ok({ session: "super-secret", baseUrl: "https://school.edu" }));
    expect(moodleFields).toEqual({ baseUrl: "https://school.edu" });
    expect(JSON.stringify(moodleFields)).not.toContain("super-secret");

    const canvasFields = nonSecretPrefill("canvas", sourceEnv(), ok({ token: "super-secret", baseUrl: "https://school.instructure.com" }));
    expect(canvasFields).toEqual({ baseUrl: "https://school.instructure.com" });
    expect(JSON.stringify(canvasFields)).not.toContain("super-secret");
  });

  it("returns nothing for gmail (Connect-flow only, no pasted fields)", () => {
    expect(nonSecretPrefill("gmail", sourceEnv(), none())).toEqual({});
  });
});

describe("buildSourcePlugins", () => {
  it("builds a plugin only for sources with a resolvable credential", async () => {
    const db = fakeDb();
    await new D1SourceCredentialStore(db, "admin-secret").save("ed", { token: "t", region: "us" });
    const credentials = new D1SourceCredentialStore(db, "admin-secret");

    const plugins = await buildSourcePlugins(sourceEnv(), credentials);

    expect(plugins.map((plugin) => plugin.id)).toEqual(["campus-ed"]);
  });

  it("builds nothing when no source is configured", async () => {
    const plugins = await buildSourcePlugins(sourceEnv(), new D1SourceCredentialStore(fakeDb(), "admin-secret"));

    expect(plugins).toEqual([]);
  });

  it("never includes gmail — it is assembled separately as a declarative manifest", async () => {
    const db = fakeDb();
    const store = new D1SourceCredentialStore(db, "admin-secret");
    await store.save("ed", { token: "t" });
    await store.save("moodle", { session: "s" });
    await store.save("canvas", { token: "t", baseUrl: "https://school.instructure.com" });

    const plugins = await buildSourcePlugins(sourceEnv({ MOODLE_SESSION: undefined }), store);

    expect(plugins.map((plugin) => plugin.id).sort()).toEqual(["campus-canvas", "campus-ed", "campus-moodle"]);
  });
});

describe("testSource", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports 'not configured' without attempting a network call", async () => {
    const result = await testSource("canvas", sourceEnv(), new D1SourceCredentialStore(fakeDb(), "admin-secret"));

    expect(result).toEqual({ ok: false, error: "Not configured yet — save a credential first." });
  });

  it("reports success and the pulled item count on a working credential", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, [])));
    const db = fakeDb();
    const store = new D1SourceCredentialStore(db, "admin-secret");
    await store.save("canvas", { baseUrl: "https://school.instructure.com", token: "t" });

    const result = await testSource("canvas", sourceEnv(), store);

    expect(result).toEqual({ ok: true, count: 0 });
  });

  it("reports the plugin's error message on a failing credential, without ever including the token", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(401, {})));
    const db = fakeDb();
    const store = new D1SourceCredentialStore(db, "admin-secret");
    await store.save("canvas", { baseUrl: "https://school.instructure.com", token: "super-secret-token" });

    const result = await testSource("canvas", sourceEnv(), store);

    expect(result).toEqual({ ok: false, error: "Canvas authentication failed." });
    expect(JSON.stringify(result)).not.toContain("super-secret-token");
  });

  it("tells the operator to reconnect instead of pulling for gmail", async () => {
    const result = await testSource("gmail", sourceEnv(), new D1SourceCredentialStore(fakeDb(), "admin-secret"));

    expect(result.ok).toBe(false);
  });
});

describe("itemCountsByPlugin", () => {
  it("groups active item counts by source, excluding archived items", async () => {
    const db = fakeItemsDb([
      { source: "campus-ed", count: 4 },
      { source: "campus-moodle", count: 2 },
    ]);

    expect(await itemCountsByPlugin(db)).toEqual({ "campus-ed": 4, "campus-moodle": 2 });
  });

  it("returns an empty object when there are no active items", async () => {
    expect(await itemCountsByPlugin(fakeItemsDb([]))).toEqual({});
  });
});

describe("buildSourceStatuses", () => {
  it("marks a source configured only once a plugin can actually be built", async () => {
    const db = fakeDb();
    await new D1SourceCredentialStore(db, "admin-secret").save("ed", { token: "t" });
    const credentials = new D1SourceCredentialStore(db, "admin-secret");

    const statuses = await buildSourceStatuses(sourceEnv(), credentials, {}, {}, false);

    const ed = statuses.find((status) => status.id === "ed");
    const moodle = statuses.find((status) => status.id === "moodle");
    expect(ed?.configured).toBe(true);
    expect(moodle?.configured).toBe(false);
  });

  it("uses the gmailConfigured flag directly, since gmail has no pasted credential", async () => {
    const statuses = await buildSourceStatuses(sourceEnv(), new D1SourceCredentialStore(fakeDb(), "admin-secret"), {}, {}, true);

    expect(statuses.find((status) => status.id === "gmail")?.configured).toBe(true);
  });

  it("surfaces needsReentry when a credential row no longer decrypts", async () => {
    const db = fakeDb();
    await new D1SourceCredentialStore(db, "old-secret").save("canvas", { token: "t", baseUrl: "https://school.instructure.com" });
    const credentials = new D1SourceCredentialStore(db, "new-secret");

    const statuses = await buildSourceStatuses(sourceEnv(), credentials, {}, {}, false);

    expect(statuses.find((status) => status.id === "canvas")?.needsReentry).toBe(true);
  });

  it("joins last-cycle timing/error and item counts by the source's plugin id", async () => {
    const statuses = await buildSourceStatuses(
      sourceEnv(),
      new D1SourceCredentialStore(fakeDb(), "admin-secret"),
      { "campus-ed": { lastSyncAt: "2026-08-01T00:00:00.000Z", lastError: "pull:timeout" } },
      { "campus-ed": 7 },
      false,
    );

    const ed = statuses.find((status) => status.id === "ed");
    expect(ed).toMatchObject({ lastSyncAt: "2026-08-01T00:00:00.000Z", lastError: "pull:timeout", items: 7 });
  });
});

// --- test helpers ----------------------------------------------------------------

function sourceEnv(overrides: Partial<SourceEnv> = {}): SourceEnv {
  return { MOODLE_BASE_URL: "https://learning.monash.edu", ...overrides };
}

function ok(fields: Record<string, string>): CredentialLookup {
  return { status: "ok", fields };
}

function none(): CredentialLookup {
  return { status: "none" };
}

function flipLastByte(base64: string): string {
  return base64.slice(0, -2) + (base64.at(-2) === "A" ? "B" : "A") + base64.slice(-1);
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null } as unknown as Headers,
    json: async () => body,
  } as unknown as Response;
}

interface FakeRow {
  ciphertext: string;
  iv: string;
  updated_at: string;
}

// A minimal fake D1 backing just the source_credentials queries D1SourceCredentialStore
// issues — mirrors tests/oauth.test.ts's FakeOAuthDb pattern.
function fakeDb() {
  const rows = new Map<string, FakeRow>();
  return {
    rows,
    prepare(sql: string) {
      return {
        bind: (...args: unknown[]) => ({
          first: async () => {
            if (sql.includes("SELECT ciphertext, iv FROM source_credentials")) {
              return rows.get(args[0] as string) ?? null;
            }
            throw new Error(`fakeDb: unexpected first() for ${sql}`);
          },
          run: async () => {
            if (sql.includes("INSERT INTO source_credentials")) {
              const [sourceId, ciphertext, iv, updatedAt] = args as string[];
              rows.set(sourceId, { ciphertext, iv, updated_at: updatedAt });
              return { success: true };
            }
            if (sql.includes("DELETE FROM source_credentials")) {
              rows.delete(args[0] as string);
              return { success: true };
            }
            throw new Error(`fakeDb: unexpected run() for ${sql}`);
          },
        }),
      };
    },
  } as unknown as D1Database & { rows: Map<string, FakeRow> };
}

function fakeItemsDb(counts: Array<{ source: string; count: number }>): D1Database {
  return {
    prepare: (sql: string) => ({
      all: async () => {
        if (sql.includes("FROM items")) {
          return { results: counts };
        }
        throw new Error(`fakeItemsDb: unexpected all() for ${sql}`);
      },
    }),
  } as unknown as D1Database;
}
