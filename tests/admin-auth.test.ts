import { describe, expect, it } from "vitest";
import { handleLogin, handleLogout, isAdminRequest, requireAdmin, safeNext, SESSION_COOKIE } from "../src/admin-auth";

const TOKEN = "admin-secret";
const ORIGIN = "https://unicorn.example";

function loginPost(password: string, next = "/panel/memory", origin = ORIGIN): Request {
  return new Request(`${ORIGIN}/login`, {
    method: "POST",
    headers: { origin, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password, next }),
  });
}

function sessionFrom(response: Response): string {
  const header = response.headers.get("set-cookie") ?? "";
  return header.split(";")[0];
}

describe("admin sign-in", () => {
  it("sends a signed-out page load to /login instead of a browser prompt", async () => {
    const response = await requireAdmin(new Request(`${ORIGIN}/panel/activity?actor=claude`), TOKEN);

    expect(response?.status).toBe(303);
    expect(response?.headers.get("location")).toBe("/login?next=%2Fpanel%2Factivity%3Factor%3Dclaude");
    expect(response?.headers.get("www-authenticate")).toBeNull();
  });

  it("answers a signed-out POST with a plain 401", async () => {
    const response = await requireAdmin(new Request(`${ORIGIN}/settings`, { method: "POST" }), TOKEN);

    expect(response?.status).toBe(401);
    expect(response?.headers.get("www-authenticate")).toBeNull();
  });

  it("still accepts the Basic header the hosted server injects", async () => {
    const request = new Request(`${ORIGIN}/panel`, { headers: { authorization: `Basic ${btoa(`unicorn:${TOKEN}`)}` } });

    expect(await requireAdmin(request, TOKEN)).toBeNull();
  });

  it("signs in with ADMIN_TOKEN and the cookie authenticates later requests", async () => {
    const response = await handleLogin(loginPost(TOKEN), TOKEN, null);
    const setCookie = response.headers.get("set-cookie") ?? "";

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/panel/memory");
    expect(setCookie).toContain(`${SESSION_COOKIE}=`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Secure");

    const later = new Request(`${ORIGIN}/panel`, { headers: { cookie: sessionFrom(response) } });
    expect(await isAdminRequest(later, TOKEN)).toBe(true);
  });

  it("rejects a wrong token without setting a cookie", async () => {
    const response = await handleLogin(loginPost("nope"), TOKEN, null);

    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.text()).toContain("not this Worker's ADMIN_TOKEN");
  });

  it("rejects a cross-origin sign-in", async () => {
    const response = await handleLogin(loginPost(TOKEN, "/panel", "https://evil.example"), TOKEN, null);

    expect(response.status).toBe(403);
  });

  it("invalidates sessions when ADMIN_TOKEN rotates", async () => {
    const cookie = sessionFrom(await handleLogin(loginPost(TOKEN), TOKEN, null));
    const later = new Request(`${ORIGIN}/panel`, { headers: { cookie } });

    expect(await isAdminRequest(later, "rotated-secret")).toBe(false);
  });

  it("rejects a forged or expired cookie", async () => {
    const [, value] = sessionFrom(await handleLogin(loginPost(TOKEN), TOKEN, null)).split("=");
    const [, signature] = value.split(".");
    const extended = new Request(`${ORIGIN}/panel`, { headers: { cookie: `${SESSION_COOKIE}=${Date.now() + 1e12}.${signature}` } });
    const expired = new Request(`${ORIGIN}/panel`, { headers: { cookie: `${SESSION_COOKIE}=1.${signature}` } });

    expect(await isAdminRequest(extended, TOKEN)).toBe(false);
    expect(await isAdminRequest(expired, TOKEN)).toBe(false);
  });

  it("signs out by clearing the cookie", async () => {
    const response = handleLogout(new Request(`${ORIGIN}/logout`, { method: "POST", headers: { origin: ORIGIN } }), null);

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/login");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("only redirects to same-site paths after sign-in", () => {
    expect(safeNext("/panel/units")).toBe("/panel/units");
    expect(safeNext("//evil.example")).toBe("/panel");
    expect(safeNext("https://evil.example")).toBe("/panel");
    expect(safeNext(null)).toBe("/panel");
  });
});
