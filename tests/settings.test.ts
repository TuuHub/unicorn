import { describe, expect, it, vi } from "vitest";
import { handleSettings, type AppSettings, type SettingsRepository } from "../src/settings";

const current: AppSettings = { retentionDays: 180, syncEnabled: true, timezone: "Australia/Melbourne" };

describe("settings", () => {
  it("requires HTTP Basic authentication", async () => {
    const response = await handleSettings(new Request("https://unicorn.example/settings"), runtime());

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Basic");
  });

  it("renders current non-secret settings and secret connection status", async () => {
    const response = await handleSettings(
      new Request("https://unicorn.example/settings", { headers: { authorization: basic("admin-secret") } }),
      runtime(),
    );
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('value="180"');
    expect(html).toContain('value="Australia/Melbourne"');
    expect(html).toContain("Moodle");
    expect(html).toContain("Configured");
    expect(html).toContain("MCP");
    expect(html).toContain("Hourly scheduler");
    expect(html).toContain("Running");
    expect(html).not.toContain("admin-secret");
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

  it("saves validated settings from the same origin", async () => {
    const repository = repositoryStub();
    const body = new URLSearchParams({
      retentionDays: "90",
      syncEnabled: "on",
      timezone: "America/New_York",
    });
    const response = await handleSettings(
      new Request("https://unicorn.example/settings", {
        method: "POST",
        headers: {
          authorization: basic("admin-secret"),
          "content-type": "application/x-www-form-urlencoded",
          origin: "https://unicorn.example",
        },
        body,
      }),
      runtime(repository),
    );

    expect(response.status).toBe(303);
    expect(repository.save).toHaveBeenCalledWith({
      retentionDays: 90,
      syncEnabled: true,
      timezone: "America/New_York",
    });
  });

  it("rejects an invalid timezone", async () => {
    const repository = repositoryStub();
    const body = new URLSearchParams({ retentionDays: "90", syncEnabled: "on", timezone: "Not/A_Zone" });
    const response = await handleSettings(
      new Request("https://unicorn.example/settings", {
        method: "POST",
        headers: {
          authorization: basic("admin-secret"),
          "content-type": "application/x-www-form-urlencoded",
          origin: "https://unicorn.example",
        },
        body,
      }),
      runtime(repository),
    );

    expect(response.status).toBe(400);
    expect(repository.save).not.toHaveBeenCalled();
  });
});

function runtime(repository = repositoryStub()) {
  return {
    adminToken: "admin-secret",
    repository,
    connections: {
      moodle: true,
      ed: true,
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

function basic(password: string): string {
  return `Basic ${btoa(`unicorn:${password}`)}`;
}
