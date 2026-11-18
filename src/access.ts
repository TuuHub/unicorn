// Optional "Continue with email" sign-in through Cloudflare Access.
//
// The Access application covers only /login/access. A request that reaches that path with a
// valid Access JWT gets the ordinary unicorn session cookie (admin-auth.ts), so every other page
// keeps one sign-in check and the ADMIN_TOKEN login keeps working beside it. The JWT is verified
// against the team's signing keys: workers.dev is reachable around Access, so the header alone
// proves nothing. The settings are written by the onboarding form (access-setup.ts) and live in
// the `settings` table under "access_login"; none of them is a secret.

export const ACCESS_LOGIN_PATH = "/login/access";
const KEY = "access_login";

export interface AccessConfig {
  /** e.g. "bunizao.cloudflareaccess.com" */
  teamDomain: string;
  /** The Access application's audience tag. */
  aud: string;
  /** The one address the application lets in. */
  email: string;
}

export async function loadAccessConfig(db: D1Database): Promise<AccessConfig | null> {
  const row = await db
    .prepare("SELECT value_json FROM settings WHERE key = ?")
    .bind(KEY)
    .first<{ value_json: string }>()
    .catch(() => null);
  if (!row) return null;
  try {
    const value = JSON.parse(row.value_json) as Partial<AccessConfig>;
    return value.teamDomain && value.aud && value.email ? { teamDomain: value.teamDomain, aud: value.aud, email: value.email } : null;
  } catch {
    return null;
  }
}

export async function saveAccessConfig(db: D1Database, config: AccessConfig, now = new Date()): Promise<void> {
  await db
    .prepare(
      `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    )
    .bind(KEY, JSON.stringify(config), now.toISOString())
    .run();
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
export async function verifyAccessJwt(token: string, config: Pick<AccessConfig, "teamDomain" | "aud">, fetcher: typeof fetch = fetch, now = Date.now()): Promise<string | null> {
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
