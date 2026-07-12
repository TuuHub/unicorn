import { describe, expect, it, vi } from "vitest";
import { handleSettings, type AppSettings, type SettingsRepository } from "../src/settings";

const current: AppSettings = { retentionDays: 180, syncEnabled: true, notificationsEnabled: false };

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
    expect(html).toContain("Moodle");
    expect(html).toContain("Connected");
    expect(html).toContain("Notifier");
    expect(html).toContain("Not configured");
    expect(html).not.toContain("admin-secret");
  });

  it("saves validated settings from the same origin", async () => {
    const repository = repositoryStub();
    const body = new URLSearchParams({
      retentionDays: "90",
      syncEnabled: "on",
      notificationsEnabled: "on",
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
      notificationsEnabled: true,
    });
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
      notifier: false,
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
