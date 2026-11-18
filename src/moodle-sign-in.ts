// "Sign in to Moodle" for a self-deployed Worker with a Browser Run binding.
//
// Start opens a remote Chrome on the user's Moodle and keeps one attempt in `settings`
// (key "moodle_sign_in"). The waiting page reloads every few seconds; each reload reads the
// Moodle cookie out of that browser and, once Moodle's dashboard accepts it, saves it as the
// Moodle credential and closes the browser. Nothing the user types passes through the Worker.

import type { LoginBrowser } from "./moodle-browser";
import { parseSesskey } from "./moodle-probe";
import type { SourceCredentialStore } from "./sources";

const KEY = "moodle_sign_in";
const TTL_MS = 10 * 60_000;

interface Attempt {
  sessionId: string;
  targetId: string;
  liveViewUrl: string;
  baseUrl: string;
  expiresAt: number;
}

export interface MoodleSignIn {
  db: D1Database;
  browser: LoginBrowser;
  credentials: SourceCredentialStore;
  /** The Moodle site to sign in to, without a trailing slash. */
  baseUrl: string;
  fetch?: typeof fetch;
  now?: () => number;
}

export type SignInState =
  | { state: "none" }
  // `seen` is what the last check found, so the waiting page can say more than "waiting".
  | { state: "waiting"; liveViewUrl: string; expiresAt: number; seen: "starting" | "login_page" | "rejected"; status?: number }
  | { state: "done" }
  | { state: "failed"; error: string };

export async function startMoodleSignIn(input: MoodleSignIn): Promise<SignInState> {
  const now = input.now ?? Date.now;
  const previous = await readAttempt(input.db);
  if (previous) await end(input, previous);
  let opened: Awaited<ReturnType<LoginBrowser["open"]>>;
  try {
    opened = await input.browser.open(`${input.baseUrl}/my/`, TTL_MS);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ event: "moodle_sign_in_start_failed", message }));
    return { state: "failed", error: `The remote browser did not start (${message}). Cloudflare's free plan allows 10 browser minutes a day.` };
  }
  const attempt: Attempt = { sessionId: opened.sessionId, targetId: opened.targetId, liveViewUrl: opened.liveViewUrl, baseUrl: input.baseUrl, expiresAt: now() + TTL_MS };
  await input.db
    .prepare(
      `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    )
    .bind(KEY, JSON.stringify(attempt), new Date(now()).toISOString())
    .run();
  return { state: "waiting", liveViewUrl: attempt.liveViewUrl, expiresAt: attempt.expiresAt, seen: "starting" };
}

export async function checkMoodleSignIn(input: MoodleSignIn): Promise<SignInState> {
  const now = input.now ?? Date.now;
  const attempt = await readAttempt(input.db);
  if (!attempt) return { state: "none" };
  if (attempt.expiresAt <= now()) {
    await end(input, attempt);
    return { state: "failed", error: "The sign-in window closed before Moodle finished. Start again." };
  }
  let cookie: { name: string; value: string } | null;
  try {
    cookie = await input.browser.readMoodleCookie(attempt, new URL(attempt.baseUrl).origin);
  } catch {
    await end(input, attempt);
    return { state: "failed", error: "The remote browser closed. Start again." };
  }
  // Moodle sets a session cookie on its login page too, so only a dashboard that loads counts.
  const status = cookie ? await dashboardStatus(attempt.baseUrl, cookie, input.fetch ?? fetch) : 0;
  if (cookie && status === 200) {
    const previous = await input.credentials.get("moodle");
    const kept = previous.status === "ok" ? previous.fields : {};
    await input.credentials.save("moodle", { ...kept, baseUrl: attempt.baseUrl, session: cookie.value, cookieName: cookie.name });
    await end(input, attempt);
    return { state: "done" };
  }
  // A cookie Moodle turns away from here, after the remote page left the login form, means
  // Moodle tied the session to the remote browser: the user is signed in there, not here.
  const seen = cookie && status !== 200 && (await input.browser.onLoginPage(attempt, attempt.baseUrl).catch(() => true)) === false ? "rejected" : "login_page";
  return { state: "waiting", liveViewUrl: attempt.liveViewUrl, expiresAt: attempt.expiresAt, seen, ...(seen === "rejected" ? { status } : {}) };
}

export async function cancelMoodleSignIn(input: MoodleSignIn): Promise<void> {
  const attempt = await readAttempt(input.db);
  if (attempt) await end(input, attempt);
}

// 200 when Moodle's dashboard loads with a session key, its HTTP status otherwise (0 on error).
async function dashboardStatus(baseUrl: string, cookie: { name: string; value: string }, fetcher: typeof fetch): Promise<number> {
  try {
    const response = await fetcher(`${baseUrl}/my/`, { headers: { cookie: `${cookie.name}=${cookie.value}` }, redirect: "manual" });
    if (!response.ok) return response.status;
    parseSesskey(await response.text());
    return 200;
  } catch {
    return 0;
  }
}

async function readAttempt(db: D1Database): Promise<Attempt | null> {
  const row = await db.prepare("SELECT value_json FROM settings WHERE key = ?").bind(KEY).first<{ value_json: string }>();
  if (!row) return null;
  try {
    return JSON.parse(row.value_json) as Attempt;
  } catch {
    return null;
  }
}

async function end(input: MoodleSignIn, attempt: Attempt): Promise<void> {
  await input.browser.close(attempt);
  await input.db.prepare("DELETE FROM settings WHERE key = ?").bind(KEY).run();
}
