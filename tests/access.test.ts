import { describe, expect, it } from "vitest";
import { verifyAccessJwt } from "../src/access";
import { setUpAccessLogin } from "../src/access-setup";
import { handleAccessLogin, handleLogin, isAdminRequest, SESSION_COOKIE } from "../src/admin-auth";

const CONFIG = { teamDomain: "team.cloudflareaccess.com", aud: "aud-tag", email: "me@example.com" };
const NOW = Date.parse("2026-11-18T00:00:00Z");

function b64url(bytes: Uint8Array | string): string {
  const raw = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  return btoa(String.fromCharCode(...raw)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function keyPair(kid: string) {
  const pair = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid } as unknown as JsonWebKey;
  return { pair, jwk, kid };
}

async function sign(key: Awaited<ReturnType<typeof keyPair>>, claims: Record<string, unknown>): Promise<string> {
  const head = b64url(JSON.stringify({ alg: "RS256", kid: key.kid }));
  const body = b64url(JSON.stringify({ aud: [CONFIG.aud], iss: `https://${CONFIG.teamDomain}`, exp: NOW / 1000 + 600, email: "me@example.com", ...claims }));
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key.pair.privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(new Uint8Array(signature))}`;
}

function certs(...keys: JsonWebKey[]): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    expect(String(input)).toBe(`https://${CONFIG.teamDomain}/cdn-cgi/access/certs`);
    return new Response(JSON.stringify({ keys }));
  }) as typeof fetch;
}

describe("Cloudflare Access", () => {
  it("accepts a JWT signed by the team for this app and rejects everything else", async () => {
    const key = await keyPair("k1");
    const other = await keyPair("k2");
    const fetcher = certs(key.jwk);

    expect(await verifyAccessJwt(await sign(key, {}), CONFIG, fetcher, NOW)).toBe("me@example.com");
    expect(await verifyAccessJwt(await sign(key, { aud: ["another-app"] }), CONFIG, fetcher, NOW)).toBeNull();
    expect(await verifyAccessJwt(await sign(key, { exp: NOW / 1000 - 1 }), CONFIG, fetcher, NOW)).toBeNull();
    expect(await verifyAccessJwt(await sign(key, { iss: "https://evil.cloudflareaccess.com" }), CONFIG, fetcher, NOW)).toBeNull();
    // Signed by a key the team never published.
    expect(await verifyAccessJwt(await sign({ ...other, kid: "k1" }, {}), CONFIG, fetcher, NOW)).toBeNull();
    expect(await verifyAccessJwt("not.a.jwt", CONFIG, fetcher, NOW)).toBeNull();
  });

  it("offers both ways in once email sign-in is set up, and only the token before", async () => {
    const withEmail = await (await handleLogin(new Request("https://u.example/login?next=/panel/memory"), "admin-secret", CONFIG)).text();
    expect(withEmail).toContain('href="/login/access?next=%2Fpanel%2Fmemory"');
    expect(withEmail).toContain("m•••@example.com");
    expect(withEmail).not.toContain("me@example.com");
    expect(withEmail).toContain('name="password"');

    const tokenOnly = await (await handleLogin(new Request("https://u.example/login"), "admin-secret", null)).text();
    expect(tokenOnly).not.toContain("/login/access");
    expect(tokenOnly).toContain('name="password"');
  });

  it("turns a verified Access JWT into a unicorn session and rejects a forged one", async () => {
    const key = await keyPair("k3");
    const fetcher = certs(key.jwk);
    // handleAccessLogin checks expiry against the real clock.
    const live = { exp: Math.floor(Date.now() / 1000) + 600 };
    const ok = await handleAccessLogin(
      new Request("https://u.example/login/access?next=/panel/memory", { headers: { "cf-access-jwt-assertion": await sign(key, live) } }),
      "admin-secret",
      CONFIG,
      fetcher,
    );
    expect(ok.status).toBe(303);
    expect(ok.headers.get("location")).toBe("/panel/memory");
    const cookie = (ok.headers.get("set-cookie") ?? "").split(";")[0]!;
    expect(cookie.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
    expect(await isAdminRequest(new Request("https://u.example/panel", { headers: { cookie } }), "admin-secret")).toBe(true);

    const forged = await handleAccessLogin(new Request("https://u.example/login/access", { headers: { "cf-access-jwt-assertion": "a.b.c" } }), "admin-secret", CONFIG, fetcher);
    expect(forged.status).toBe(401);
    expect(forged.headers.get("set-cookie")).toBeNull();
    // The header means nothing on any other page.
    expect(await isAdminRequest(new Request("https://u.example/panel", { headers: { "cf-access-jwt-assertion": await sign(key, live) } }), "admin-secret")).toBe(false);
  });

  it("sends /login/access back to /login when email sign-in isn't set up", async () => {
    const response = await handleAccessLogin(new Request("https://u.example/login/access?next=/panel/units"), "admin-secret", null);
    expect(response.headers.get("location")).toBe("/login?next=%2Fpanel%2Funits");
  });
});

describe("email sign-in setup", () => {
  function cloudflare(state: { org: boolean; pin: boolean; app: boolean }) {
    const calls: string[] = [];
    const bodies: Record<string, unknown> = {};
    const ok = (result: unknown) => new Response(JSON.stringify({ success: true, result }));
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).replace("https://api.cloudflare.com/client/v4", "").replace(/\?.*$/, "");
      const method = init?.method ?? "GET";
      calls.push(`${method} ${path}`);
      if (init?.body) bodies[`${method} ${path}`] = JSON.parse(String(init.body));
      if (path === "/accounts") return ok([{ id: "acct1234abcd", name: "Me" }]);
      if (path.endsWith("/organizations")) {
        if (method === "GET" && !state.org) return new Response(JSON.stringify({ success: false, errors: [{ message: "not found" }] }), { status: 404 });
        return ok({ auth_domain: method === "GET" ? "team.cloudflareaccess.com" : "unicorn-acct1234.cloudflareaccess.com" });
      }
      if (path.endsWith("/identity_providers")) return method === "GET" ? ok(state.pin ? [{ id: "pin1", type: "onetimepin" }] : []) : ok({ id: "pin2" });
      if (path.endsWith("/apps")) return method === "GET" ? ok(state.app ? [{ id: "app1", aud: "old", domain: "u.example/login/access" }] : []) : ok({ id: "app2", aud: "new-aud" });
      if (path.endsWith("/apps/app1")) return ok({ id: "app1", aud: "same-aud" });
      return new Response("{}", { status: 500 });
    }) as typeof fetch;
    return { calls, bodies, fetcher };
  }

  it("creates the organization, PIN login and app on a fresh account", async () => {
    const api = cloudflare({ org: false, pin: false, app: false });
    const config = await setUpAccessLogin({ apiToken: "t", email: "me@example.com", host: "u.example", fetch: api.fetcher });

    expect(config).toEqual({ teamDomain: "unicorn-acct1234.cloudflareaccess.com", aud: "new-aud", email: "me@example.com" });
    expect(api.calls).toContain("POST /accounts/acct1234abcd/access/organizations");
    expect(api.calls).toContain("POST /accounts/acct1234abcd/access/identity_providers");
    const app = api.bodies["POST /accounts/acct1234abcd/access/apps"] as { domain: string; allowed_idps: string[]; policies: { include: unknown[] }[] };
    expect(app.domain).toBe("u.example/login/access");
    expect(app.allowed_idps).toEqual(["pin2"]);
    expect(app.policies[0]!.include).toEqual([{ email: { email: "me@example.com" } }]);
  });

  it("reuses what already exists and updates the app in place", async () => {
    const api = cloudflare({ org: true, pin: true, app: true });
    const config = await setUpAccessLogin({ apiToken: "t", email: "new@example.com", host: "u.example", fetch: api.fetcher });

    expect(config).toEqual({ teamDomain: "team.cloudflareaccess.com", aud: "same-aud", email: "new@example.com" });
    expect(api.calls.filter((call) => call.startsWith("POST"))).toEqual([]);
    expect(api.calls).toContain("PUT /accounts/acct1234abcd/access/apps/app1");
  });

  it("explains a rejected token", async () => {
    const fetcher = (async () => new Response(JSON.stringify({ success: false, errors: [{ message: "Invalid API Token" }] }), { status: 401 })) as unknown as typeof fetch;
    await expect(setUpAccessLogin({ apiToken: "bad", email: "me@example.com", host: "u.example", fetch: fetcher })).rejects.toThrow("didn't accept that API token");
  });
});
