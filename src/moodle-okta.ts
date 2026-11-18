// The Worker signing in to Moodle through Okta by itself, with okta-auth's plain HTTP sign-in.
// No browser: username, password and a TOTP secret go to Okta, the MoodleSession cookie comes back.
//
// The login comes from the OKTA_USERNAME / OKTA_PASSWORD / OKTA_TOTP_SECRET Worker secrets, or from
// the Moodle card on /settings, where it is stored encrypted with the Moodle credential. Okta's
// device token, its session and the retry state are kept next to it, so a renewal doesn't read as
// a new device and doesn't spend a one-time code while Okta's own session lasts.
//
// Rules from moodle-cli's Worker: a rejected password or code, or an MFA factor other than TOTP,
// stops renewal until the login changes, because retrying counts towards Okta's lockout. Anything
// else backs off, and stops after five failures in a row.

import { OktaSignInError, signIn, type Cookie } from "okta-auth-cli";
import type { SourceCredentialStore } from "./sources";

export interface OktaEnv {
  OKTA_USERNAME?: string;
  OKTA_PASSWORD?: string;
  OKTA_TOTP_SECRET?: string;
}

export interface OktaLogin {
  username: string;
  password: string;
  totpSecret: string;
}

export type OktaBlock = "credentials_rejected" | "passcode_rejected" | "mfa_unsupported" | "invalid_secret" | "retries_exhausted";

interface OktaState {
  // Digest of the login the rest was earned with. A changed login starts over.
  login: string;
  blocked?: OktaBlock;
  failures: number;
  nextAttemptAt?: number;
  deviceToken?: string;
  oktaSession?: Cookie[];
  lastSignInAt?: string;
}

export interface MoodleCookie {
  name: string;
  value: string;
}

// Okta checks a one-time code once, so two attempts inside one 30-second window would fail.
const MIN_ATTEMPT_INTERVAL_MS = 60_000;
const MAX_BACKOFF_MS = 30 * 60_000;
const MAX_TRANSIENT_FAILURES = 5;

export class OktaRenewError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "OktaRenewError";
  }
}

const BLOCK_MESSAGES: Record<OktaBlock, string> = {
  credentials_rejected: "Okta rejected the username or password. Enter them again.",
  passcode_rejected: "Okta rejected the one-time code. Check the TOTP secret and the clock, then enter it again.",
  mfa_unsupported: "Okta asked for push, SMS or email. Only an authenticator app (TOTP) works here.",
  invalid_secret: "The TOTP secret isn't base32. Copy the setup key again.",
  retries_exhausted: "Okta failed five times in a row. Save the login again to retry.",
};

/** The login from Worker secrets (all three set) or from the stored Moodle credential. */
export function oktaLogin(env: OktaEnv, stored: Record<string, string> | undefined): OktaLogin | null {
  const fromEnv = pick(env.OKTA_USERNAME, env.OKTA_PASSWORD, env.OKTA_TOTP_SECRET);
  return fromEnv ?? pick(stored?.oktaUsername, stored?.oktaPassword, stored?.oktaTotpSecret);
}

function pick(username?: string, password?: string, totpSecret?: string): OktaLogin | null {
  const user = username?.trim();
  const secret = totpSecret?.replace(/\s+/g, "").toUpperCase();
  return user && password && secret ? { username: user, password, totpSecret: secret } : null;
}

export type OktaStatus =
  | { state: "off" }
  | { state: "ready"; lastSignInAt?: string }
  | { state: "blocked"; message: string }
  | { state: "waiting"; failures: number; nextAttemptAt?: number };

/** What the Moodle card says about Okta, without signing in. */
export async function oktaStatus(env: OktaEnv, stored: Record<string, string> | undefined): Promise<OktaStatus> {
  const login = oktaLogin(env, stored);
  if (!login) return { state: "off" };
  const state = stateFor(readState(stored), await digest(login));
  if (state.blocked) return { state: "blocked", message: BLOCK_MESSAGES[state.blocked] };
  if (state.failures > 0) return { state: "waiting", failures: state.failures, nextAttemptAt: state.nextAttemptAt };
  return { state: "ready", lastSignInAt: state.lastSignInAt };
}

export interface RenewInput {
  baseUrl: string;
  env: OktaEnv;
  credentials: SourceCredentialStore;
  fetch?: typeof fetch;
  now?: () => number;
  // A sign-in the user just asked for skips the one-minute spacing, never a block.
  manual?: boolean;
}

/**
 * Signs in through Okta and saves the new Moodle session. Null when no Okta login is set up.
 * Throws OktaRenewError when Okta refuses, is backing off, or is blocked.
 */
export async function renewMoodleSession(input: RenewInput): Promise<MoodleCookie | null> {
  const now = input.now ?? Date.now;
  const lookup = await input.credentials.get("moodle");
  const stored = lookup.status === "ok" ? lookup.fields : undefined;
  const login = oktaLogin(input.env, stored);
  if (!login) return null;

  let state = stateFor(readState(stored), await digest(login));
  if (state.blocked) throw new OktaRenewError(`okta_${state.blocked}`, BLOCK_MESSAGES[state.blocked]);
  if (!input.manual && state.nextAttemptAt !== undefined && state.nextAttemptAt > now()) {
    throw new OktaRenewError("okta_backoff", "Okta sign-in is waiting before its next try.");
  }

  const save = (fields: Record<string, string>) => input.credentials.save("moodle", { ...(stored ?? {}), baseUrl: input.baseUrl, ...fields });
  try {
    const result = await signIn({
      url: `${input.baseUrl}/my/`,
      username: login.username,
      password: login.password,
      totpSecret: login.totpSecret,
      ...(state.deviceToken ? { deviceToken: state.deviceToken } : {}),
      ...(state.oktaSession?.length ? { oktaSession: state.oktaSession } : {}),
      ...(input.fetch ? { fetch: (url: string, init: RequestInit) => input.fetch!(url, init) } : {}),
      now,
    });
    const cookie = moodleCookie(result.cookies);
    if (!cookie) throw new OktaSignInError("handoff_failed", "Okta signed in, but Moodle set no session cookie.");
    state = {
      login: state.login,
      failures: 0,
      nextAttemptAt: now() + MIN_ATTEMPT_INTERVAL_MS,
      deviceToken: result.deviceToken ?? state.deviceToken,
      oktaSession: result.oktaSession,
      lastSignInAt: new Date(now()).toISOString(),
    };
    await save({ session: cookie.value, cookieName: cookie.name, oktaState: JSON.stringify(state) });
    return cookie;
  } catch (error) {
    state = afterFailure(state, error, now());
    await save({ oktaState: JSON.stringify(state) });
    if (state.blocked) throw new OktaRenewError(`okta_${state.blocked}`, BLOCK_MESSAGES[state.blocked]);
    const code = error instanceof OktaSignInError ? error.code : "network";
    throw new OktaRenewError(`okta_${code}`, `Okta sign-in failed (${code}). unicorn tries again later.`);
  }
}

function afterFailure(state: OktaState, error: unknown, now: number): OktaState {
  const permanent = permanentBlock(error);
  if (permanent) return { ...state, blocked: permanent, nextAttemptAt: undefined };
  const failures = state.failures + 1;
  if (failures >= MAX_TRANSIENT_FAILURES) return { ...state, failures, blocked: "retries_exhausted", nextAttemptAt: undefined };
  return { ...state, failures, nextAttemptAt: now + Math.min(MIN_ATTEMPT_INTERVAL_MS * 2 ** (failures - 1), MAX_BACKOFF_MS) };
}

function permanentBlock(error: unknown): OktaBlock | null {
  if (error instanceof OktaSignInError) {
    if (error.code === "credentials_rejected" || error.code === "passcode_rejected" || error.code === "mfa_unsupported") return error.code;
    return null;
  }
  // okta-auth throws TypeError for input it refuses before reaching Okta, such as a non-base32 secret.
  return error instanceof TypeError ? "invalid_secret" : null;
}

function moodleCookie(cookies: readonly Cookie[]): MoodleCookie | null {
  const match = cookies
    .filter((cookie) => /^MoodleSession[A-Za-z0-9_-]*$/.test(cookie.name) && cookie.value)
    .sort((left, right) => right.path.length - left.path.length)[0];
  return match ? { name: match.name, value: match.value } : null;
}

function readState(stored: Record<string, string> | undefined): OktaState | undefined {
  if (!stored?.oktaState) return undefined;
  try {
    return JSON.parse(stored.oktaState) as OktaState;
  } catch {
    return undefined;
  }
}

/** The stored state when it belongs to this login; a clean slate (keeping the device token) otherwise. */
function stateFor(stored: OktaState | undefined, login: string): OktaState {
  if (stored?.login === login) return stored;
  return { login, failures: 0, ...(stored?.deviceToken ? { deviceToken: stored.deviceToken } : {}) };
}

// Only ever stored inside the encrypted credential, so a plain SHA-256 tells a changed login apart.
async function digest(login: OktaLogin): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([login.username, login.password, login.totpSecret]));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
