import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { D1OAuthTokenStore, getAccessToken, handleCallback, OAuthError, startAuthorization, type OAuthEnv } from "../src/oauth";

interface FakeRow {
  plugin_id: string;
  provider: string;
  refresh_token: string;
  access_token: string | null;
  expires_at: string | null;
  scope: string | null;
  updated_at: string;
}

// A minimal fake D1 backing just the oauth_tokens queries D1OAuthTokenStore issues —
// enough to exercise store/refresh logic without a real database.
class FakeOAuthDb {
  rows = new Map<string, FakeRow>();

  prepare(sql: string) {
    return {
      bind: (...args: unknown[]) => ({
        first: async () => {
          if (sql.includes("SELECT * FROM oauth_tokens")) {
            return this.rows.get(args[0] as string) ?? null;
          }
          throw new Error(`FakeOAuthDb: unexpected first() for ${sql}`);
        },
        run: async () => {
          if (sql.includes("INSERT INTO oauth_tokens")) {
            const [pluginId, provider, refreshToken, accessToken, expiresAt, scope, updatedAt] = args as string[];
            this.rows.set(pluginId, {
              plugin_id: pluginId,
              provider,
              refresh_token: refreshToken,
              access_token: accessToken,
              expires_at: expiresAt,
              scope,
              updated_at: updatedAt,
            });
            return { success: true };
          }
          if (sql.includes("UPDATE oauth_tokens")) {
            const [accessToken, expiresAt, updatedAt, pluginId] = args as string[];
            const row = this.rows.get(pluginId);
            if (row) {
              row.access_token = accessToken;
              row.expires_at = expiresAt;
              row.updated_at = updatedAt;
            }
            return { success: true };
          }
          throw new Error(`FakeOAuthDb: unexpected run() for ${sql}`);
        },
      }),
    };
  }
}

function env(db: FakeOAuthDb, overrides: Partial<OAuthEnv> = {}): OAuthEnv {
  return {
    DB: db as unknown as D1Database,
    ADMIN_TOKEN: "admin-secret",
    PLUGIN_SECRET_GOOGLE_CLIENT_ID: "client-id",
    PLUGIN_SECRET_GOOGLE_CLIENT_SECRET: "client-secret",
    ...overrides,
  };
}

describe("startAuthorization", () => {
  it("builds a Google consent URL requesting offline access and gmail.readonly", async () => {
    const url = await startAuthorization("gmail", "google", env(new FakeOAuthDb()), new URL("https://unicorn.example/settings/oauth/gmail/start"));

    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(parsed.searchParams.get("client_id")).toBe("client-id");
    expect(parsed.searchParams.get("redirect_uri")).toBe("https://unicorn.example/settings/oauth/callback");
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/gmail.readonly");
    expect(parsed.searchParams.get("access_type")).toBe("offline");
    expect(parsed.searchParams.get("prompt")).toBe("consent");
    expect(parsed.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it("rejects when the Google client id secret is not configured", async () => {
    await expect(
      startAuthorization("gmail", "google", env(new FakeOAuthDb(), { PLUGIN_SECRET_GOOGLE_CLIENT_ID: undefined }), new URL("https://unicorn.example/settings/oauth/gmail/start")),
    ).rejects.toMatchObject({ code: "oauth_not_configured" });
  });
});

describe("handleCallback", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T00:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function stateFor(db: FakeOAuthDb, pluginId = "gmail") {
    const url = await startAuthorization(pluginId, "google", env(db), new URL("https://unicorn.example/settings/oauth/gmail/start"));
    return new URL(url).searchParams.get("state")!;
  }

  it("rejects a request missing code or state", async () => {
    const db = new FakeOAuthDb();
    await expect(handleCallback(new URL("https://unicorn.example/settings/oauth/callback"), env(db))).rejects.toMatchObject({
      code: "oauth_invalid_request",
    });
  });

  it("rejects when Google reports an error", async () => {
    const db = new FakeOAuthDb();
    await expect(
      handleCallback(new URL("https://unicorn.example/settings/oauth/callback?error=access_denied"), env(db)),
    ).rejects.toMatchObject({ code: "oauth_denied" });
  });

  it("rejects a tampered state signature", async () => {
    const db = new FakeOAuthDb();
    const state = await stateFor(db);
    const tampered = state.slice(0, -1) + (state.at(-1) === "A" ? "B" : "A");
    await expect(
      handleCallback(new URL(`https://unicorn.example/settings/oauth/callback?code=abc&state=${tampered}`), env(db)),
    ).rejects.toMatchObject({ code: "oauth_state_invalid" });
  });

  it("rejects an expired state", async () => {
    const db = new FakeOAuthDb();
    const state = await stateFor(db);
    vi.setSystemTime(new Date("2026-08-01T00:11:00.000Z")); // 11 minutes later
    await expect(
      handleCallback(new URL(`https://unicorn.example/settings/oauth/callback?code=abc&state=${state}`), env(db)),
    ).rejects.toMatchObject({ code: "oauth_state_invalid" });
  });

  it("exchanges the code and stores the refresh token", async () => {
    const db = new FakeOAuthDb();
    const state = await stateFor(db);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({ access_token: "at-1", refresh_token: "rt-1", expires_in: 3600, scope: "gmail.readonly" }),
    );

    const result = await handleCallback(
      new URL(`https://unicorn.example/settings/oauth/callback?code=abc&state=${state}`),
      env(db),
      fetchImpl,
    );

    expect(result).toEqual({ pluginId: "gmail", provider: "google" });
    const stored = await new D1OAuthTokenStore(db as unknown as D1Database).get("gmail");
    expect(stored).toMatchObject({ pluginId: "gmail", provider: "google", refreshToken: "rt-1", accessToken: "at-1" });
    expect(fetchImpl).toHaveBeenCalledWith("https://oauth2.googleapis.com/token", expect.objectContaining({ method: "POST" }));
  });

  it("keeps the existing refresh token when Google omits one on re-consent", async () => {
    const db = new FakeOAuthDb();
    db.rows.set("gmail", {
      plugin_id: "gmail",
      provider: "google",
      refresh_token: "rt-original",
      access_token: null,
      expires_at: null,
      scope: null,
      updated_at: "2026-07-01T00:00:00.000Z",
    });
    const state = await stateFor(db);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ access_token: "at-2", expires_in: 3600 }));

    await handleCallback(new URL(`https://unicorn.example/settings/oauth/callback?code=abc&state=${state}`), env(db), fetchImpl);

    const stored = await new D1OAuthTokenStore(db as unknown as D1Database).get("gmail");
    expect(stored?.refreshToken).toBe("rt-original");
    expect(stored?.accessToken).toBe("at-2");
  });

  it("fails when Google returns no refresh token and none is on file", async () => {
    const db = new FakeOAuthDb();
    const state = await stateFor(db);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ access_token: "at-1", expires_in: 3600 }));

    await expect(
      handleCallback(new URL(`https://unicorn.example/settings/oauth/callback?code=abc&state=${state}`), env(db), fetchImpl),
    ).rejects.toMatchObject({ code: "oauth_missing_refresh_token" });
  });

  it("surfaces a non-ok token exchange as oauth_exchange_failed", async () => {
    const db = new FakeOAuthDb();
    const state = await stateFor(db);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("bad", { status: 400 }));

    await expect(
      handleCallback(new URL(`https://unicorn.example/settings/oauth/callback?code=abc&state=${state}`), env(db), fetchImpl),
    ).rejects.toMatchObject({ code: "oauth_exchange_failed" });
  });
});

describe("getAccessToken", () => {
  it("fails when no token is stored for the plugin", async () => {
    const db = new FakeOAuthDb();
    await expect(getAccessToken("gmail", env(db))).rejects.toMatchObject({ code: "oauth_not_connected" });
  });

  it("returns the cached access token without refreshing when it is still valid", async () => {
    const db = new FakeOAuthDb();
    db.rows.set("gmail", {
      plugin_id: "gmail",
      provider: "google",
      refresh_token: "rt-1",
      access_token: "at-cached",
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      scope: null,
      updated_at: new Date().toISOString(),
    });
    const fetchImpl = vi.fn<typeof fetch>();

    const token = await getAccessToken("gmail", env(db), fetchImpl);

    expect(token).toBe("at-cached");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refreshes and persists a new access token when the cached one is expired", async () => {
    const db = new FakeOAuthDb();
    db.rows.set("gmail", {
      plugin_id: "gmail",
      provider: "google",
      refresh_token: "rt-1",
      access_token: "at-old",
      expires_at: new Date(Date.now() - 1000).toISOString(),
      scope: null,
      updated_at: new Date().toISOString(),
    });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ access_token: "at-new", expires_in: 3600 }));

    const token = await getAccessToken("gmail", env(db), fetchImpl);

    expect(token).toBe("at-new");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://oauth2.googleapis.com/token",
      expect.objectContaining({ method: "POST" }),
    );
    const stored = await new D1OAuthTokenStore(db as unknown as D1Database).get("gmail");
    expect(stored?.accessToken).toBe("at-new");
  });

  it("surfaces a failed refresh as oauth_refresh_failed", async () => {
    const db = new FakeOAuthDb();
    db.rows.set("gmail", {
      plugin_id: "gmail",
      provider: "google",
      refresh_token: "rt-1",
      access_token: null,
      expires_at: null,
      scope: null,
      updated_at: new Date().toISOString(),
    });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("bad", { status: 401 }));

    await expect(getAccessToken("gmail", env(db), fetchImpl)).rejects.toMatchObject({ code: "oauth_refresh_failed" });
  });
});

describe("OAuthError", () => {
  it("carries a stable code", () => {
    const error = new OAuthError("oauth_not_configured", "nope");
    expect(error.code).toBe("oauth_not_configured");
    expect(error).toBeInstanceOf(Error);
  });
});
