// Optional Cloudflare Access in front of the human pages (/panel, /settings, /login, /authorize).
//
// When ACCESS_TEAM_DOMAIN and ACCESS_AUD are set, a request carrying a valid Access JWT counts as
// signed in, so the owner logs in with Access (email code, GitHub, ...) instead of ADMIN_TOKEN.
// The token login stays as the fallback. The JWT is verified against the team's signing keys:
// workers.dev is reachable around Access, so the header alone proves nothing.

export interface AccessConfig {
  /** e.g. "bunizao.cloudflareaccess.com" */
  teamDomain: string;
  /** The Access application's audience tag. */
  aud: string;
}

export function accessConfig(env: { ACCESS_TEAM_DOMAIN?: string; ACCESS_AUD?: string }): AccessConfig | undefined {
  const teamDomain = env.ACCESS_TEAM_DOMAIN?.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const aud = env.ACCESS_AUD?.trim();
  return teamDomain && aud ? { teamDomain, aud } : undefined;
}

interface Jwk extends JsonWebKey {
  kid?: string;
}

const KEY_TTL_MS = 60 * 60 * 1000;
let cachedKeys: { teamDomain: string; at: number; keys: Jwk[] } | null = null;

async function signingKeys(teamDomain: string, fetcher: typeof fetch, now: number, refresh = false): Promise<Jwk[]> {
  if (!refresh && cachedKeys && cachedKeys.teamDomain === teamDomain && now - cachedKeys.at < KEY_TTL_MS) return cachedKeys.keys;
  const response = await fetcher(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!response.ok) throw new Error(`Access certs returned ${response.status}`);
  const keys = ((await response.json()) as { keys?: Jwk[] }).keys ?? [];
  cachedKeys = { teamDomain, at: now, keys };
  return keys;
}

/** The signed-in email when `token` is a valid Access JWT for this application, otherwise null. */
export async function verifyAccessJwt(token: string, config: AccessConfig, fetcher: typeof fetch = fetch, now = Date.now()): Promise<string | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(decodeSegment(parts[0]!)) as { alg?: string; kid?: string };
    const payload = JSON.parse(decodeSegment(parts[1]!)) as { aud?: string | string[]; exp?: number; nbf?: number; iss?: string; email?: string };
    if (header.alg !== "RS256" || !header.kid) return null;
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!audiences.includes(config.aud)) return null;
    if (payload.iss !== `https://${config.teamDomain}`) return null;
    if (typeof payload.exp !== "number" || payload.exp * 1000 <= now) return null;
    if (typeof payload.nbf === "number" && payload.nbf * 1000 > now + 60_000) return null;

    let jwk = (await signingKeys(config.teamDomain, fetcher, now)).find((key) => key.kid === header.kid);
    // Access rotates keys; an unknown kid may just mean the cache is older than the rotation.
    if (!jwk) jwk = (await signingKeys(config.teamDomain, fetcher, now, true)).find((key) => key.kid === header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, decodeBytes(parts[2]!), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    return valid ? (payload.email ?? "") : null;
  } catch {
    return null;
  }
}

function decodeBytes(segment: string): Uint8Array {
  const base64 = segment.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(segment.length / 4) * 4, "=");
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

function decodeSegment(segment: string): string {
  return new TextDecoder().decode(decodeBytes(segment));
}
