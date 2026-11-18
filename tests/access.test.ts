import { describe, expect, it } from "vitest";
import { accessConfig, verifyAccessJwt } from "../src/access";
import { isAdminRequest } from "../src/admin-auth";

const CONFIG = { teamDomain: "team.cloudflareaccess.com", aud: "aud-tag" };
const NOW = Date.parse("2026-11-18T00:00:00Z");

function b64url(bytes: Uint8Array | string): string {
  const raw = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  return btoa(String.fromCharCode(...raw)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function keyPair(kid: string) {
  const pair = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid };
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
  it("is off unless both settings are present", () => {
    expect(accessConfig({})).toBeUndefined();
    expect(accessConfig({ ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com/", ACCESS_AUD: "aud-tag" })).toEqual(CONFIG);
  });

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

  it("signs in with a valid Access header and still takes the admin token without one", async () => {
    const forged = new Request("https://u.example/panel", { headers: { "cf-access-jwt-assertion": "a.b.c" } });
    expect(await isAdminRequest(forged, "admin-secret", CONFIG)).toBe(false);
    const basic = new Request("https://u.example/panel", { headers: { authorization: `Basic ${btoa("unicorn:admin-secret")}` } });
    expect(await isAdminRequest(basic, "admin-secret", CONFIG)).toBe(true);
  });
});
