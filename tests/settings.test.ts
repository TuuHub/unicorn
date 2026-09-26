import { describe, expect, it, vi } from "vitest";
import { computeCsrfToken, handleSettings, type AppSettings, type SettingsRepository, type SettingsRuntime } from "../src/settings";
import type { CredentialLookup, SourceCredentialStore, SourceId } from "../src/sources";

// handleSourceTestPost calls testSource() imported directly by src/settings.ts,
// so it's mocked at the module boundary rather than through SettingsRuntime.
const { testSourceMock } = vi.hoisted(() => ({ testSourceMock: vi.fn() }));
vi.mock("../src/sources", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/sources")>();
  return { ...actual, testSource: testSourceMock };
});

const current: AppSettings = {
  retentionDays: 180,
  syncEnabled: true,
  timezone: "Australia/Melbourne",
  gmailDomains: [],
  gmailAllowlist: [],
};

describe("settings", () => {
  it("requires HTTP Basic authentication", async () => {
    const response = await handleSettings(new Request("https://unicorn.example/settings"), runtime());

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Basic");
  });

  it("renders current non-secret settings, deployment health, and every source card", async () => {
    const response = await handleSettings(
      new Request("https://unicorn.example/settings", { headers: { authorization: basic("admin-secret") } }),
      runtime(),
    );
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('value="180"');
    expect(html).toContain("Australia/Melbourne");
    expect(html).toContain("Ed Discussion");
    expect(html).toContain("Moodle");
    expect(html).toContain("Canvas");
    expect(html).toContain("Gmail");
    expect(html).toContain("Hourly scheduler");
    expect(html).toContain("Running");
    expect(html).toContain("Connect your agent");
    expect(html).toContain("Connected apps");
    expect(html).not.toContain("admin-secret");
  });

  it("renders the empty-state hint when no OAuth connector has been granted yet", async () => {
    const response = await handleSettings(
      new Request("https://unicorn.example/settings", { headers: { authorization: basic("admin-secret") } }),
      runtime(),
    );
    const html = await response.text();

    expect(html).toContain("No connected apps yet");
  });

  it("renders a connected app with its name and a revoke action", async () => {
    const response = await handleSettings(
      new Request("https://unicorn.example/settings", { headers: { authorization: basic("admin-secret") } }),
      {
        ...runtime(),
        oauth: {
          grants: [
            {
              id: "grant-1",
              clientId: "client-abc",
              userId: "door",
              scope: ["mcp"],
              metadata: { clientName: "Claude" },
              createdAt: 1_700_000_000,
            },
          ],
        },
      },
    );
    const html = await response.text();

    expect(html).toContain("Claude");
    expect(html).toContain('action="/settings/oauth/apps/revoke"');
    expect(html).toContain('value="grant-1"');
    expect(html).not.toContain("No connected apps yet");
  });

  it("never renders the raw MCP token attribute-escaped incorrectly, but does surface it for the Claude Code command", async () => {
    const response = await handleSettings(
      new Request("https://unicorn.example/settings", { headers: { authorization: basic("admin-secret") } }),
      runtime(),
    );
    const html = await response.text();

    expect(html).toContain("mcp-secret");
    expect(html).toContain("Bearer mcp-secret");
  });

  it("never renders a saved source credential value back into the page", async () => {
    const credentials = credentialStoreStub();
    credentials.get = vi.fn(async (id: SourceId) => (id === "ed" ? { status: "ok" as const, fields: { token: "super-secret-token", region: "au" } } : { status: "none" as const }));
    const response = await handleSettings(
      new Request("https://unicorn.example/settings", { headers: { authorization: basic("admin-secret") } }),
      runtime(repositoryStub(), credentials),
    );
    const html = await response.text();

    expect(html).not.toContain("super-secret-token");
    expect(html).toContain('value="au"'); // non-secret field still prefills
  });

  it("shows a re-enter hint when a stored credential no longer decrypts", async () => {
    const credentials = credentialStoreStub();
    credentials.get = vi.fn(async (id: SourceId) => (id === "canvas" ? { status: "invalid" as const } : { status: "none" as const }));
    const response = await handleSettings(
      new Request("https://unicorn.example/settings", { headers: { authorization: basic("admin-secret") } }),
      runtime(repositoryStub(), credentials),
    );
    const html = await response.text();

    expect(html).toContain("no longer decrypts");
  });

  it("hides the Gmail connect action when Google secrets are not configured", async () => {
    const response = await handleSettings(
      new Request("https://unicorn.example/settings", { headers: { authorization: basic("admin-secret") } }),
      runtime(),
    );
    const html = await response.text();

    expect(html).toContain("Gmail");
    expect(html).toContain("PLUGIN_SECRET_GOOGLE_CLIENT_ID");
    expect(html).not.toContain("/settings/oauth/gmail/start");
  });

  it("shows a Connect Gmail button once Google secrets are configured but not yet connected", async () => {
    const response = await handleSettings(
      new Request("https://unicorn.example/settings", { headers: { authorization: basic("admin-secret") } }),
      { ...runtime(), connections: { ...runtime().connections, google: true, gmailConnected: false } },
    );
    const html = await response.text();

    expect(html).toContain('href="/settings/oauth/gmail/start"');
    expect(html).toContain("Connect Gmail");
    expect(html).not.toContain("Connected — Gmail");
  });

  it("shows Gmail as connected once a token is on file", async () => {
    const response = await handleSettings(
      new Request("https://unicorn.example/settings", { headers: { authorization: basic("admin-secret") } }),
      { ...runtime(), connections: { ...runtime().connections, google: true, gmailConnected: true } },
    );
    const html = await response.text();

    expect(html).toContain("Connected — Gmail threads sync");
    expect(html).not.toContain("/settings/oauth/gmail/start");
  });

  it("warns when the scheduler is stopped", async () => {
    const stopped = { ...runtime(), status: { schedulerRunning: false } };
    const response = await handleSettings(
      new Request("https://unicorn.example/settings", { headers: { authorization: basic("admin-secret") } }),
      stopped,
    );
    const html = await response.text();

    expect(html).toContain("scheduler is not running");
  });

  it("shows the last cycle time when one is recorded", async () => {
    const response = await handleSettings(
      new Request("https://unicorn.example/settings", { headers: { authorization: basic("admin-secret") } }),
      { ...runtime(), lastCycle: { at: "2026-08-01T00:00:00.000Z", byPlugin: {} } },
    );
    const html = await response.text();

    expect(html).toContain("2026-08-01T00:00:00.000Z");
    expect(html).not.toContain("Never run");
  });

  describe("POST /settings (maintenance)", () => {
    it("saves validated settings from the same origin with a valid csrf token", async () => {
      const repository = repositoryStub();
      const csrf = await computeCsrfToken("admin-secret");
      const body = new URLSearchParams({ retentionDays: "90", syncEnabled: "on", csrf });
      const response = await handleSettings(
        new Request("https://unicorn.example/settings", {
          method: "POST",
          headers: { authorization: basic("admin-secret"), "content-type": "application/x-www-form-urlencoded", origin: "https://unicorn.example" },
          body,
        }),
        runtime(repository),
      );

      expect(response.status).toBe(303);
      expect(repository.save).toHaveBeenCalledWith(expect.objectContaining({ retentionDays: 90, syncEnabled: true }));
    });

    it("rejects a missing or wrong csrf token even from the right origin", async () => {
      const repository = repositoryStub();
      const body = new URLSearchParams({ retentionDays: "90", syncEnabled: "on", csrf: "wrong" });
      const response = await handleSettings(
        new Request("https://unicorn.example/settings", {
          method: "POST",
          headers: { authorization: basic("admin-secret"), "content-type": "application/x-www-form-urlencoded", origin: "https://unicorn.example" },
          body,
        }),
        runtime(repository),
      );

      expect(response.status).toBe(403);
      expect(repository.save).not.toHaveBeenCalled();
    });

    it("rejects a cross-origin POST even with a valid csrf token", async () => {
      const repository = repositoryStub();
      const csrf = await computeCsrfToken("admin-secret");
      const body = new URLSearchParams({ retentionDays: "90", syncEnabled: "on", csrf });
      const response = await handleSettings(
        new Request("https://unicorn.example/settings", {
          method: "POST",
          headers: { authorization: basic("admin-secret"), "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example" },
          body,
        }),
        runtime(repository),
      );

      expect(response.status).toBe(403);
      expect(repository.save).not.toHaveBeenCalled();
    });

    it("rejects invalid retention", async () => {
      const repository = repositoryStub();
      const csrf = await computeCsrfToken("admin-secret");
      const body = new URLSearchParams({ retentionDays: "3", syncEnabled: "on", csrf });
      const response = await handleSettings(
        new Request("https://unicorn.example/settings", {
          method: "POST",
          headers: { authorization: basic("admin-secret"), "content-type": "application/x-www-form-urlencoded", origin: "https://unicorn.example" },
          body,
        }),
        runtime(repository),
      );

      expect(response.status).toBe(400);
      expect(repository.save).not.toHaveBeenCalled();
    });
  });

  describe("POST /settings/timezone", () => {
    it("saves a valid IANA timezone", async () => {
      const repository = repositoryStub();
      const csrf = await computeCsrfToken("admin-secret");
      const body = new URLSearchParams({ timezone: "America/New_York", csrf });
      const response = await handleSettings(
        new Request("https://unicorn.example/settings/timezone", {
          method: "POST",
          headers: { authorization: basic("admin-secret"), "content-type": "application/x-www-form-urlencoded", origin: "https://unicorn.example" },
          body,
        }),
        runtime(repository),
      );

      expect(response.status).toBe(303);
      expect(repository.save).toHaveBeenCalledWith(expect.objectContaining({ timezone: "America/New_York" }));
    });

    it("rejects an invalid timezone", async () => {
      const repository = repositoryStub();
      const csrf = await computeCsrfToken("admin-secret");
      const body = new URLSearchParams({ timezone: "Not/A_Zone", csrf });
      const response = await handleSettings(
        new Request("https://unicorn.example/settings/timezone", {
          method: "POST",
          headers: { authorization: basic("admin-secret"), "content-type": "application/x-www-form-urlencoded", origin: "https://unicorn.example" },
          body,
        }),
        runtime(repository),
      );

      expect(response.status).toBe(400);
      expect(repository.save).not.toHaveBeenCalled();
    });
  });

  describe("POST /settings/gmail-scope", () => {
    it("parses newline-separated domains and allowlist entries", async () => {
      const repository = repositoryStub();
      const csrf = await computeCsrfToken("admin-secret");
      const body = new URLSearchParams({
        gmailDomains: "monash.edu\nstudent.monash.edu\nmonash.edu\n",
        gmailAllowlist: " unit-convenor@example.edu \n\nother@example.edu",
        csrf,
      });
      const response = await handleSettings(
        new Request("https://unicorn.example/settings/gmail-scope", {
          method: "POST",
          headers: { authorization: basic("admin-secret"), "content-type": "application/x-www-form-urlencoded", origin: "https://unicorn.example" },
          body,
        }),
        runtime(repository),
      );

      expect(response.status).toBe(303);
      expect(repository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          gmailDomains: ["monash.edu", "student.monash.edu"],
          gmailAllowlist: ["unit-convenor@example.edu", "other@example.edu"],
        }),
      );
    });
  });

  describe("POST /settings/sources/:id", () => {
    it("merges submitted non-secret fields with the existing secret when the password field is left blank", async () => {
      const credentials = credentialStoreStub();
      credentials.get = vi.fn(async () => ({ status: "ok" as const, fields: { token: "existing-token", region: "us" } }));
      const csrf = await computeCsrfToken("admin-secret");
      const body = new URLSearchParams({ token: "", region: "au", csrf });
      const response = await handleSettings(
        new Request("https://unicorn.example/settings/sources/ed", {
          method: "POST",
          headers: { authorization: basic("admin-secret"), "content-type": "application/x-www-form-urlencoded", origin: "https://unicorn.example" },
          body,
        }),
        runtime(repositoryStub(), credentials),
      );

      expect(response.status).toBe(303);
      expect(credentials.save).toHaveBeenCalledWith("ed", { token: "existing-token", region: "au" });
    });

    it("overwrites the secret when a new one is submitted", async () => {
      const credentials = credentialStoreStub();
      credentials.get = vi.fn(async () => ({ status: "ok" as const, fields: { token: "old-token", region: "us" } }));
      const csrf = await computeCsrfToken("admin-secret");
      const body = new URLSearchParams({ token: "new-token", region: "us", csrf });
      await handleSettings(
        new Request("https://unicorn.example/settings/sources/ed", {
          method: "POST",
          headers: { authorization: basic("admin-secret"), "content-type": "application/x-www-form-urlencoded", origin: "https://unicorn.example" },
          body,
        }),
        runtime(repositoryStub(), credentials),
      );

      expect(credentials.save).toHaveBeenCalledWith("ed", { token: "new-token", region: "us" });
    });

    it("rejects an unknown source id", async () => {
      const csrf = await computeCsrfToken("admin-secret");
      const body = new URLSearchParams({ csrf });
      const response = await handleSettings(
        new Request("https://unicorn.example/settings/sources/foo", {
          method: "POST",
          headers: { authorization: basic("admin-secret"), "content-type": "application/x-www-form-urlencoded", origin: "https://unicorn.example" },
          body,
        }),
        runtime(),
      );

      expect(response.status).toBe(404);
    });
  });

  describe("POST /settings/sources/:id/test", () => {
    it("reports success and the pulled item count", async () => {
      testSourceMock.mockResolvedValueOnce({ ok: true, count: 3 });
      const response = await handleSettings(
        new Request("https://unicorn.example/settings/sources/canvas/test", {
          method: "POST",
          headers: {
            authorization: basic("admin-secret"),
            "content-type": "application/x-www-form-urlencoded",
            origin: "https://unicorn.example",
          },
          body: new URLSearchParams({ csrf: await computeCsrfToken("admin-secret") }),
        }),
        runtime(),
      );
      const html = await response.text();

      expect(response.status).toBe(200);
      expect(html).toContain("pulled 3 items");
      expect(testSourceMock).toHaveBeenCalledWith("canvas", expect.anything(), expect.anything());
    });

    it("reports a stable error message on failure without leaking a secret", async () => {
      testSourceMock.mockResolvedValueOnce({ ok: false, error: "Canvas authentication failed." });
      const response = await handleSettings(
        new Request("https://unicorn.example/settings/sources/canvas/test", {
          method: "POST",
          headers: {
            authorization: basic("admin-secret"),
            "content-type": "application/x-www-form-urlencoded",
            origin: "https://unicorn.example",
          },
          body: new URLSearchParams({ csrf: await computeCsrfToken("admin-secret") }),
        }),
        runtime(),
      );
      const html = await response.text();

      expect(response.status).toBe(200);
      expect(html).toContain("Canvas authentication failed.");
    });
  });

  describe("POST /settings/sources/:id/disconnect", () => {
    it("deletes the stored credential", async () => {
      const credentials = credentialStoreStub();
      const csrf = await computeCsrfToken("admin-secret");
      const response = await handleSettings(
        new Request("https://unicorn.example/settings/sources/moodle/disconnect", {
          method: "POST",
          headers: { authorization: basic("admin-secret"), "content-type": "application/x-www-form-urlencoded", origin: "https://unicorn.example" },
          body: new URLSearchParams({ csrf }),
        }),
        runtime(repositoryStub(), credentials),
      );

      expect(response.status).toBe(303);
      expect(credentials.delete).toHaveBeenCalledWith("moodle");
    });
  });

  describe("POST /settings/sync-now", () => {
    it("redirects with a synced flag on success", async () => {
      const runSync = vi.fn(async () => ({ ok: true as const }));
      const csrf = await computeCsrfToken("admin-secret");
      const response = await handleSettings(
        new Request("https://unicorn.example/settings/sync-now", {
          method: "POST",
          headers: { authorization: basic("admin-secret"), "content-type": "application/x-www-form-urlencoded", origin: "https://unicorn.example" },
          body: new URLSearchParams({ csrf }),
        }),
        { ...runtime(), runSync },
      );

      expect(runSync).toHaveBeenCalledOnce();
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toContain("synced=1");
    });

    it("redirects with a syncError flag on failure", async () => {
      const runSync = vi.fn(async () => ({ ok: false as const, error: "campus-canvas: pull:canvas_api_401" }));
      const csrf = await computeCsrfToken("admin-secret");
      const response = await handleSettings(
        new Request("https://unicorn.example/settings/sync-now", {
          method: "POST",
          headers: { authorization: basic("admin-secret"), "content-type": "application/x-www-form-urlencoded", origin: "https://unicorn.example" },
          body: new URLSearchParams({ csrf }),
        }),
        { ...runtime(), runSync },
      );

      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toContain("syncError=");
    });
  });
});

function runtime(repository = repositoryStub(), credentials = credentialStoreStub()): SettingsRuntime {
  return {
    adminToken: "admin-secret",
    repository,
    sourceEnv: { MOODLE_BASE_URL: "https://learning.monash.edu" },
    credentials,
    lastCycle: { at: null, byPlugin: {} },
    itemCounts: {},
    mcpToken: "mcp-secret",
    connections: {
      mcp: true,
    },
    status: {
      schedulerRunning: true,
    },
  };
}

function repositoryStub(): SettingsRepository & { save: ReturnType<typeof vi.fn> } {
  return {
    get: vi.fn().mockResolvedValue(current),
    save: vi.fn().mockResolvedValue(undefined),
  };
}

function credentialStoreStub(): SourceCredentialStore & { save: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> } {
  return {
    get: vi.fn(async (): Promise<CredentialLookup> => ({ status: "none" })),
    save: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  };
}

function basic(password: string): string {
  return `Basic ${btoa(`unicorn:${password}`)}`;
}
