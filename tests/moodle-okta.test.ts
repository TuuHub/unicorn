import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const signIn = vi.fn();
vi.mock("okta-auth-cli", async (importOriginal) => ({ ...(await importOriginal<typeof import("okta-auth-cli")>()), signIn }));

const { OktaSignInError } = await import("okta-auth-cli");
const { moodleUsesOkta, oktaStatus, renewMoodleSession } = await import("../src/moodle-okta");
import type { CredentialLookup, SourceCredentialStore, SourceId } from "../src/sources";

function store(fields: Record<string, string>) {
  let saved: Record<string, string> = fields;
  const credentials: SourceCredentialStore = {
    get: async (_id: SourceId): Promise<CredentialLookup> => ({ status: "ok", fields: saved }),
    save: async (_id, next) => {
      saved = next;
    },
    delete: async () => undefined,
  };
  return { credentials, current: () => saved };
}

const LOGIN = { oktaUsername: "student", oktaPassword: "pw", oktaTotpSecret: "JBSWY3DPEHPK3PXP" };
const BASE = "https://moodle.example.edu";

describe("renewMoodleSession", () => {
  beforeEach(() => signIn.mockReset());
  // vitest reports a mock still set to reject when the test ends, even though the code caught it.
  afterEach(() => signIn.mockReset());

  it("returns null without an Okta login", async () => {
    const { credentials } = store({ session: "x" });
    expect(await renewMoodleSession({ baseUrl: BASE, env: {}, credentials })).toBeNull();
    expect(signIn).not.toHaveBeenCalled();
  });

  it("saves the Moodle cookie, its name and Okta's device token", async () => {
    signIn.mockResolvedValue({
      cookies: [{ name: "MoodleSession", value: "fresh", domain: "moodle.example.edu", path: "/", secure: true, httpOnly: true }],
      deviceToken: "dt",
      oktaSession: [],
      landingUrl: `${BASE}/my/`,
    });
    const { credentials, current } = store({ ...LOGIN, baseUrl: BASE });

    const cookie = await renewMoodleSession({ baseUrl: BASE, env: {}, credentials, now: () => 1_000 });

    expect(cookie).toEqual({ name: "MoodleSession", value: "fresh" });
    expect(current()).toMatchObject({ ...LOGIN, session: "fresh", cookieName: "MoodleSession" });
    expect(JSON.parse(current().oktaState!)).toMatchObject({ deviceToken: "dt", failures: 0 });
    expect(signIn).toHaveBeenCalledWith(expect.objectContaining({ url: `${BASE}/my/`, username: "student", totpSecret: "JBSWY3DPEHPK3PXP" }));
  });

  it("stops after a rejected password and never retries it", async () => {
    signIn.mockRejectedValue(new OktaSignInError("credentials_rejected", "no"));
    const { credentials, current } = store({ ...LOGIN });

    await expect(renewMoodleSession({ baseUrl: BASE, env: {}, credentials })).rejects.toMatchObject({ code: "okta_credentials_rejected" });
    await expect(renewMoodleSession({ baseUrl: BASE, env: {}, credentials, manual: true })).rejects.toMatchObject({ code: "okta_credentials_rejected" });
    expect(signIn).toHaveBeenCalledOnce();
    expect(await oktaStatus({}, current())).toMatchObject({ state: "blocked" });

    // A new password lifts the block.
    signIn.mockResolvedValue({ cookies: [{ name: "MoodleSession", value: "ok", domain: "d", path: "/", secure: true, httpOnly: true }], deviceToken: undefined, oktaSession: [], landingUrl: "" });
    await credentials.save("moodle", { ...current(), oktaPassword: "new" });
    expect(await renewMoodleSession({ baseUrl: BASE, env: {}, credentials })).toEqual({ name: "MoodleSession", value: "ok" });
  });

  it("backs off after a network failure until the next attempt time", async () => {
    signIn.mockRejectedValue(new OktaSignInError("network", "down"));
    const { credentials, current } = store({ ...LOGIN });

    await expect(renewMoodleSession({ baseUrl: BASE, env: {}, credentials, now: () => 0 })).rejects.toMatchObject({ code: "okta_network" });
    await expect(renewMoodleSession({ baseUrl: BASE, env: {}, credentials, now: () => 10_000 })).rejects.toMatchObject({ code: "okta_backoff" });
    expect(signIn).toHaveBeenCalledOnce();
    expect(await oktaStatus({}, current())).toMatchObject({ state: "waiting", failures: 1 });
  });
});

describe("moodleUsesOkta", () => {
  const redirect = (location: string) => new Response(null, { status: 303, headers: { location } });

  it("follows Moodle's redirects to an Okta host", async () => {
    const pages: Record<string, Response> = {
      "https://moodle.example.edu/my/": redirect("/login/index.php"),
      "https://moodle.example.edu/login/index.php": redirect("https://moodle.example.edu/auth/saml2/login.php"),
      "https://moodle.example.edu/auth/saml2/login.php": new Response('<form method="post" action="https://school.okta.com/app/sso/saml"><input name="SAMLRequest" value="x"></form>'),
    };
    const fetcher = vi.fn(async (input: RequestInfo | URL) => pages[String(input)] ?? new Response("", { status: 404 }));
    expect(await moodleUsesOkta(BASE, fetcher as unknown as typeof fetch)).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("says no for Moodle's own login form or another identity provider", async () => {
    const own = vi.fn(async (input: RequestInfo | URL) => (String(input).endsWith("/my/") ? redirect("/login/index.php") : new Response('<form><input name="password"></form>')));
    expect(await moodleUsesOkta(BASE, own as unknown as typeof fetch)).toBe(false);
    const microsoft = vi.fn(async () => redirect("https://login.microsoftonline.com/tenant/saml2"));
    expect(await moodleUsesOkta(BASE, microsoft as unknown as typeof fetch)).toBe(false);
  });
});
