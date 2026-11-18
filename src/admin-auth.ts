// Sign-in for a self-deployed Worker's human pages (/panel, /settings, /authorize).
//
// Two ways in: the ADMIN_TOKEN password, or "Continue with email" through Cloudflare Access once
// the owner has set it up (access.ts). Either one sets the same session cookie: an expiry and an HMAC of it keyed
// by ADMIN_TOKEN, so rotating the secret signs every browser out and there is no session table.
// A Basic header carrying the same token is still accepted: the hosted server (server/app.ts)
// injects one after its own session check, and scripts can keep using curl -u.

import { ACCESS_LOGIN_PATH, type AccessConfig, verifyAccessJwt } from "./access";
import { constantTimeEqual, isBasicAuthorized } from "./settings";
import { icon } from "./marks";
import { escapeHtml, htmlResponse, renderPage } from "./ui";

export const SESSION_COOKIE = "unicorn_session";
const SESSION_SECONDS = 30 * 24 * 60 * 60;

export async function isAdminRequest(request: Request, adminToken: string): Promise<boolean> {
  if (!adminToken) return false;
  if (isBasicAuthorized(request.headers.get("authorization"), adminToken)) return true;
  const cookie = readCookie(request, SESSION_COOKIE);
  if (!cookie) return false;
  const [expires, signature] = cookie.split(".");
  if (!expires || !signature || !(Number(expires) > Date.now())) return false;
  return constantTimeEqual(signature, await sign(adminToken, expires));
}

/** Null when signed in. Otherwise a page load goes to /login; anything else gets a plain 401. */
export async function requireAdmin(request: Request, adminToken: string): Promise<Response | null> {
  if (await isAdminRequest(request, adminToken)) return null;
  const url = new URL(request.url);
  if (request.method === "GET" || request.method === "HEAD") {
    return redirect(`/login?next=${encodeURIComponent(url.pathname + url.search)}`);
  }
  return new Response("Sign in first.", { status: 401, headers: { "cache-control": "no-store" } });
}

export async function handleLogin(request: Request, adminToken: string, access: AccessConfig | null): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET") {
    if (await isAdminRequest(request, adminToken)) return redirect(safeNext(url.searchParams.get("next")));
    return renderLogin(safeNext(url.searchParams.get("next")), access);
  }
  if (request.method !== "POST") return new Response("Method not allowed.", { status: 405, headers: { allow: "GET, POST" } });
  if (request.headers.get("origin") !== url.origin) return new Response("Invalid request origin.", { status: 403 });

  const form = await request.formData();
  const next = safeNext(String(form.get("next") ?? ""));
  const password = String(form.get("password") ?? "");
  if (!adminToken || !constantTimeEqual(password, adminToken)) {
    return renderLogin(next, access, "That is not this Worker's ADMIN_TOKEN.");
  }
  return signIn(url, adminToken, next);
}

/**
 * GET /login/access, the one path the Access application covers. Access has already asked for
 * the email code by the time the request gets here; a verified JWT becomes a unicorn session.
 */
export async function handleAccessLogin(request: Request, adminToken: string, access: AccessConfig | null, fetcher: typeof fetch = fetch): Promise<Response> {
  const url = new URL(request.url);
  const next = safeNext(url.searchParams.get("next"));
  if (!access) return redirect(`/login?next=${encodeURIComponent(next)}`);
  const jwt = request.headers.get("cf-access-jwt-assertion");
  if (!adminToken || !jwt || (await verifyAccessJwt(jwt, access, fetcher)) === null) {
    return renderLogin(next, access, "Cloudflare Access didn't sign you in. If you set email sign-in up a minute ago, try again shortly, or use the admin token.");
  }
  return signIn(url, adminToken, next);
}

export function handleLogout(request: Request, access: AccessConfig | null): Response {
  const url = new URL(request.url);
  if (request.headers.get("origin") !== url.origin) return new Response("Invalid request origin.", { status: 403 });
  // Behind Access, clearing our cookie alone would leave the browser signed in through Access.
  return redirect(access ? "/cdn-cgi/access/logout" : "/login", cookie(url, "", 0));
}

export function safeNext(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return "/panel";
  return value;
}

async function signIn(url: URL, adminToken: string, next: string): Promise<Response> {
  const expires = String(Date.now() + SESSION_SECONDS * 1000);
  const value = `${expires}.${await sign(adminToken, expires)}`;
  return redirect(next, cookie(url, value, SESSION_SECONDS));
}

function renderLogin(next: string, access: AccessConfig | null, error?: string): Response {
  // With email sign-in set up, it is the main way in and the token form sits below it.
  const email = access
    ? `<a class="button lg auth-email" href="${ACCESS_LOGIN_PATH}?next=${encodeURIComponent(next)}">Continue with email${icon("arrow")}</a>
       <p class="hint auth-email-hint">A code goes to ${escapeHtml(maskEmail(access.email))}.</p>
       <p class="auth-or"><span>or use the admin token</span></p>`
    : "";
  const body = `
    ${error ? `<p class="notice error" role="alert">${escapeHtml(error)}</p>` : ""}
    ${email}
    <form class="auth-form" method="post" action="/login">
      <input type="hidden" name="next" value="${escapeHtml(next)}">
      <input type="text" name="username" value="unicorn" autocomplete="username" hidden>
      <label class="field" for="password">Admin token</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required${access ? "" : " autofocus"}>
      <p class="hint">The <code>ADMIN_TOKEN</code> secret you set when you deployed this Worker.</p>
      <button type="submit" class="lg auth-submit${access ? " secondary" : ""}">Sign in${access ? "" : icon("arrow")}</button>
    </form>
    <style>
      .auth-form label.field{margin-top:0}.auth-submit{margin-top:20px;width:100%}
      .auth-email{display:flex;justify-content:center;width:100%}
      .auth-email-hint{margin:8px 0 0;text-align:center}
      .auth-or{display:flex;align-items:center;gap:12px;margin:24px 0 20px;color:var(--muted);font-size:12.5px}
      .auth-or::before,.auth-or::after{content:"";flex:1;height:1px;background:var(--border)}
    </style>`;
  return htmlResponse(
    renderPage({
      title: "unicorn — sign in",
      active: "",
      heading: "Sign in to unicorn",
      subtitle: "Deadlines across your units, every call your agents made, and what they remember about you.",
      body,
      layout: "door",
      actions: "Self-hosted",
    }),
    error ? 401 : 200,
  );
}

/** "bunizaoccc@gmail.com" → "b•••@gmail.com": enough to recognise, not enough to harvest. */
function maskEmail(email: string): string {
  const at = email.indexOf("@");
  return at > 0 ? `${email[0]}•••${email.slice(at)}` : email;
}

async function sign(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`session:${message}`));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

function cookie(url: URL, value: string, maxAge: number): string {
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function redirect(location: string, setCookie?: string): Response {
  const headers = new Headers({ location, "cache-control": "no-store" });
  if (setCookie) headers.append("set-cookie", setCookie);
  return new Response(null, { status: 303, headers });
}
