// The hosted, multi-tenant unicorn (ADR-0046) as one fetch handler, so it is testable without a
// socket. It is a thin shell around the unchanged Worker code:
//
//   /mcp                      the door — OAuth access token or personal access token → tenant →
//                             src/index.ts handleDoor with that tenant's Env
//   /authorize                sign in (in the connector's pop-up) → consent → grant for the tenant
//   /panel*, /settings*       signed-in session → src/index.ts defaultFetch with the tenant's Env,
//                             exactly the pages a self-deployed Worker serves behind Basic auth
//   /, /login, /signup, /account, /logout   the hosted-only pages (server/pages.ts)
//   /api/sources/moodle/session   lets `npm run moodle:push -- --hosted` deliver a fresh session
//
// One OAuth authorization server for the whole instance; a grant's user id is the tenant id, so
// a token can only ever reach the tenant that approved it.

import { handleDoor, defaultFetch } from "../src/index";
import { createOAuthProvider, type DoorProps, handleAuthorize, type OAuthServerEnv } from "../src/oauth-server";
import type { Env } from "../src/runtime/cycle";
import { computeCsrfToken } from "../src/settings";
import { D1SourceCredentialStore } from "../src/sources";
import { AccountError, type Account, type ControlStore } from "./control";
import { renderAccountPage, renderAuthForm, renderLanding } from "./pages";
import type { TenantManager } from "./tenants";

export interface HostedConfig {
  publicUrl: string; // e.g. https://unicorn.example.com — every URL the server emits starts here
  operator: string; // shown on the landing page: who runs this instance
  repoUrl: string;
  signupOpen: boolean;
  signupCode?: string; // when set, sign-up requires it (an invite code)
  maxAccounts?: number;
}

export interface HostedDeps {
  control: ControlStore;
  tenants: TenantManager;
  config: HostedConfig;
  runCycle?: (env: Env) => Promise<unknown>;
  log?: (event: Record<string, unknown>) => void;
}

interface HostEnv extends OAuthServerEnv {
  OAUTH_PROVIDER?: import("@cloudflare/workers-oauth-provider").OAuthHelpers;
}

const MAX_OAUTH_CLIENTS = 100_000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;

export function createHostedApp(deps: HostedDeps): { fetch(request: Request, ip?: string): Promise<Response> } {
  const { control, tenants, config } = deps;
  const log = deps.log ?? ((event) => console.log(JSON.stringify(event)));
  const origin = new URL(config.publicUrl).origin;
  const secure = origin.startsWith("https://");
  const cookieName = secure ? "__Host-unicorn_session" : "unicorn_session";
  const attempts = new Map<string, { count: number; resetAt: number }>();

  const hostEnv: HostEnv = {
    // The provider only touches OAUTH_KV; DB/ADMIN_TOKEN/MCP_TOKEN belong to tenants, not the host.
    DB: undefined as unknown as D1Database,
    ADMIN_TOKEN: "",
    MCP_TOKEN: "",
    OAUTH_KV: control.kv(),
  };

  const doorHandler = async (request: Request, _env: HostEnv, ctx: ExecutionContext): Promise<Response> => {
    const props = (ctx as unknown as { props?: DoorProps }).props;
    const account = props?.subject ? control.get(props.subject) : null;
    if (!account) {
      return Response.json({ error: "invalid_token", error_description: "This unicorn account no longer exists." }, { status: 401 });
    }
    return handleDoor(request, tenants.env(account.id), ctx);
  };

  const pageHandler = async (request: Request, env: HostEnv, ctx: ExecutionContext): Promise<Response> => {
    const url = new URL(request.url);
    const path = url.pathname;
    const account = control.sessionAccount(readCookie(request, cookieName));

    if (request.method === "GET" && path === "/") {
      return renderLanding({ signedIn: Boolean(account), operator: config.operator, accounts: control.count(), signupOpen: signupAllowed(), repoUrl: config.repoUrl });
    }
    if (request.method === "GET" && path === "/health") {
      return Response.json({ status: "ready", mode: "hosted", accounts: control.count() });
    }
    if (path === "/login" || path === "/signup") {
      return handleAuthPage(request, url, path === "/signup" ? "signup" : "login", account);
    }
    if (path === "/logout" && request.method === "POST") {
      const token = readCookie(request, cookieName);
      if (token) control.deleteSession(token);
      return redirect("/", clearCookie());
    }
    if (path === "/authorize") {
      if (!account) {
        if (request.method !== "GET") return new Response("Sign in first.", { status: 401 });
        return renderAuthForm({ mode: "login", next: path + url.search, signupOpen: signupAllowed(), needsCode: Boolean(config.signupCode), popup: true });
      }
      return handleAuthorize(request, env.OAUTH_PROVIDER!, account.id);
    }
    if (path === "/api/sources/moodle/session" && request.method === "POST") {
      return handleMoodlePush(request);
    }
    if (path === "/account" || path.startsWith("/account/")) {
      if (!account) return redirect(`/login?next=${encodeURIComponent(path)}`);
      return handleAccount(request, url, account);
    }
    if (path === "/panel" || path.startsWith("/panel/") || path === "/settings" || path.startsWith("/settings/")) {
      if (!account) {
        return request.method === "GET" ? redirect(`/login?next=${encodeURIComponent(path + url.search)}`) : new Response("Sign in first.", { status: 401 });
      }
      const tenantEnv = { ...tenants.env(account.id), OAUTH_PROVIDER: env.OAUTH_PROVIDER } as Env;
      return defaultFetch(await withBasicAuth(request, tenantEnv.ADMIN_TOKEN), tenantEnv, ctx);
    }
    if (path === "/mcp/admin") {
      return Response.json({ error: "not_available", hint: "The admin MCP is available on self-deployed Workers only." }, { status: 404 });
    }
    return new Response("Not found.", { status: 404 });
  };

  const provider = createOAuthProvider<HostEnv>(hostEnv, origin, doorHandler, pageHandler, {
    maxClients: MAX_OAUTH_CLIENTS,
    clientIdMetadataDocuments: false,
    resolveBearer: async (token) => {
      const owner = control.resolvePersonalToken(token);
      return owner ? { subject: owner.id, via: "mcp_token", clientName: undefined } : null;
    },
  });

  function signupAllowed(): boolean {
    return config.signupOpen && (config.maxAccounts === undefined || control.count() < config.maxAccounts);
  }

  async function handleAuthPage(request: Request, url: URL, mode: "login" | "signup", account: Account | null): Promise<Response> {
    const next = safeNext(url.searchParams.get("next"));
    const popup = next.startsWith("/authorize");
    const base = { next, signupOpen: signupAllowed(), needsCode: Boolean(config.signupCode), popup };
    if (request.method === "GET") {
      if (account) return redirect(next);
      if (mode === "signup" && !signupAllowed()) return redirect(`/login?next=${encodeURIComponent(next)}`);
      return renderAuthForm({ mode, ...base });
    }
    if (request.method !== "POST") return new Response("Method not allowed.", { status: 405 });
    if (request.headers.get("origin") !== origin) return new Response("Invalid request origin.", { status: 403 });
    const form = await request.formData();
    const email = String(form.get("email") ?? "");
    const password = String(form.get("password") ?? "");
    const formNext = safeNext(String(form.get("next") ?? ""));
    const formBase = { ...base, next: formNext, popup: formNext.startsWith("/authorize"), email };
    if (mode === "signup") {
      if (!signupAllowed()) return renderAuthForm({ mode, ...formBase, error: "Sign-up is closed on this instance." });
      if (config.signupCode && String(form.get("code") ?? "").trim() !== config.signupCode) {
        return renderAuthForm({ mode, ...formBase, error: "That invite code is not valid." });
      }
      try {
        const created = control.createAccount(email, password);
        tenants.database(created.id); // create and migrate the tenant database now
        log({ event: "account_created", tenant: created.id });
        return startSession(created.id, formNext === "/" ? "/panel" : formNext);
      } catch (error) {
        if (error instanceof AccountError) return renderAuthForm({ mode, ...formBase, error: error.message });
        throw error;
      }
    }
    const ip = request.headers.get("x-unicorn-client-ip") ?? "unknown";
    if (!allowAttempt(ip)) {
      return renderAuthForm({ mode, ...formBase, error: "Too many sign-in attempts. Wait a few minutes and try again." });
    }
    const verified = control.verifyLogin(email, password);
    if (!verified) return renderAuthForm({ mode, ...formBase, error: "Email or password is incorrect." });
    return startSession(verified.id, formNext === "/" ? "/panel" : formNext);
  }

  function allowAttempt(ip: string): boolean {
    const now = Date.now();
    const entry = attempts.get(ip);
    if (!entry || entry.resetAt < now) {
      attempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
      return true;
    }
    entry.count += 1;
    return entry.count <= LOGIN_MAX_ATTEMPTS;
  }

  function startSession(accountId: string, next: string): Response {
    const { token, expiresAt } = control.createSession(accountId);
    const cookie = `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Expires=${expiresAt.toUTCString()}${secure ? "; Secure" : ""}`;
    return redirect(next, cookie);
  }

  function clearCookie(): string {
    return `${cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
  }

  async function handleAccount(request: Request, url: URL, account: Account): Promise<Response> {
    const adminToken = control.tenantAdminToken(account.id);
    const csrf = await computeCsrfToken(adminToken);
    if (request.method === "GET" && url.pathname === "/account") {
      const notice = url.searchParams.get("rotated") ? "Token rotated. Update any client that used the old one." : undefined;
      return renderAccountPage({ email: account.email, createdAt: account.createdAt, csrf, notice });
    }
    if (request.method !== "POST") return new Response("Method not allowed.", { status: 405 });
    if (request.headers.get("origin") !== origin) return new Response("Invalid request origin.", { status: 403 });
    const form = await request.formData();
    if (String(form.get("csrf") ?? "") !== csrf) return new Response("Invalid form token.", { status: 403 });
    if (url.pathname === "/account/rotate-token") {
      control.rotateToken(account.id);
      return redirect("/account?rotated=1");
    }
    if (url.pathname === "/account/delete") {
      if (String(form.get("confirm") ?? "").trim().toLowerCase() !== account.email) {
        return renderAccountPage({ email: account.email, createdAt: account.createdAt, csrf, error: "The email you typed does not match this account." });
      }
      control.deleteAccount(account.id);
      tenants.destroy(account.id);
      log({ event: "account_deleted", tenant: account.id });
      return redirect("/", clearCookie());
    }
    return new Response("Not found.", { status: 404 });
  }

  // `npm run moodle:push -- --hosted <url> --token <personal token>` posts a MoodleSession cookie
  // here after a local Okta login, the hosted counterpart of `wrangler secret put MOODLE_SESSION`.
  async function handleMoodlePush(request: Request): Promise<Response> {
    const header = request.headers.get("authorization") ?? "";
    const owner = header.startsWith("Bearer ") ? control.resolvePersonalToken(header.slice(7)) : null;
    if (!owner) return Response.json({ error: "unauthorized" }, { status: 401 });
    let body: { session?: unknown; baseUrl?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return Response.json({ error: "invalid_json" }, { status: 400 });
    }
    const session = typeof body.session === "string" ? body.session.trim() : "";
    if (!session || session.length > 4096) return Response.json({ error: "invalid_session" }, { status: 400 });
    const env = tenants.env(owner.id);
    const store = new D1SourceCredentialStore(env.DB, env.ADMIN_TOKEN);
    const existing = await store.get("moodle");
    const baseUrl = typeof body.baseUrl === "string" && /^https:\/\//.test(body.baseUrl) ? body.baseUrl : existing.status === "ok" ? existing.fields.baseUrl ?? env.MOODLE_BASE_URL : env.MOODLE_BASE_URL;
    await store.save("moodle", { ...(existing.status === "ok" ? existing.fields : {}), baseUrl, session });
    log({ event: "moodle_session_pushed", tenant: owner.id });
    return Response.json({ ok: true, baseUrl });
  }

  return {
    async fetch(request: Request, ip?: string): Promise<Response> {
      const headers = new Headers(request.headers);
      headers.delete("x-unicorn-client-ip");
      if (ip) headers.set("x-unicorn-client-ip", ip);
      const tagged = new Request(request, { headers });
      const ctx = executionContext(log);
      try {
        return await provider.fetch(tagged, hostEnv, ctx);
      } catch (error) {
        log({ event: "request_failed", path: new URL(request.url).pathname, message: error instanceof Error ? error.message : String(error) });
        return Response.json({ error: "internal_error" }, { status: 500 });
      }
    },
  };
}

function executionContext(log: (event: Record<string, unknown>) => void): ExecutionContext {
  return {
    waitUntil(promise: Promise<unknown>) {
      promise.catch((error) => log({ event: "background_failed", message: error instanceof Error ? error.message : String(error) }));
    },
    passThroughOnException() {},
    props: {},
  } as unknown as ExecutionContext;
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=") || null;
  }
  return null;
}

function redirect(location: string, cookie?: string): Response {
  const headers = new Headers({ location, "cache-control": "no-store" });
  if (cookie) headers.append("set-cookie", cookie);
  return new Response(null, { status: 303, headers });
}

function safeNext(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return "/panel";
  return value;
}

// The tenant's pages are the Worker's own, which authenticate with Basic auth against ADMIN_TOKEN.
// The session already proved who this is; hand the Worker code the credential it expects.
async function withBasicAuth(request: Request, adminToken: string): Promise<Request> {
  const headers = new Headers(request.headers);
  headers.set("authorization", `Basic ${btoa(`unicorn:${adminToken}`)}`);
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  return new Request(request.url, { method: request.method, headers, body: hasBody ? await request.arrayBuffer() : undefined, redirect: "manual" });
}
