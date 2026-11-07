// Pages only the hosted server has (ADR-0046): the front door and sign-up / sign-in (also shown
// inside the OAuth pop-up a connector opens), and the account page. Everything after sign-in is
// the shared panel and /settings from src/.
//
// There is no marketing page here on purpose: what unicorn is and how it works lives on
// unicorn.tuuhub.com, and the door links there. The door says only what is specific to this
// instance — who runs it, how many people use it, and what that means for their tokens.

import { icon } from "../src/marks";
import { escapeHtml, htmlResponse, renderPage } from "../src/ui";

export interface InstanceInfo {
  operator: string;
  accounts: number;
  repoUrl: string;
}

export interface LandingOptions extends InstanceInfo {
  signupOpen: boolean;
  needsCode: boolean;
}

/** `/` for a signed-out visitor: the sign-in door. A signed-in one is sent to the panel. */
export function renderLanding(options: LandingOptions): Response {
  return renderAuthForm({
    mode: "login",
    next: "/panel",
    signupOpen: options.signupOpen,
    needsCode: options.needsCode,
    popup: false,
    instance: { operator: options.operator, accounts: options.accounts, repoUrl: options.repoUrl },
  });
}

export interface AuthFormOptions {
  mode: "login" | "signup";
  next: string;
  error?: string;
  email?: string;
  signupOpen: boolean;
  needsCode: boolean;
  popup: boolean;
  instance?: InstanceInfo;
}

const AUTH_STYLE = `<style>
.auth-form label.field:first-of-type{margin-top:0}
.auth-submit{margin-top:20px;width:100%}
.auth-switch{margin:18px 0 0;text-align:center;color:var(--ink-2);font-size:13.5px}
.auth-switch a{color:var(--ink);font-weight:500;text-decoration:underline;text-decoration-color:var(--rule);text-underline-offset:3px}
.fine{margin:14px 0 0;color:var(--ink-3);font-size:12.5px;line-height:1.55}
.trust{list-style:none;margin:28px 0 0;padding:18px 0 0;border-top:1px solid var(--rule);display:flex;flex-direction:column;gap:10px}
.trust li{display:flex;gap:10px;font-size:13px;color:var(--ink-2)}
.trust li .i{width:16px;height:16px;margin-top:2px;color:var(--ink-3)}
.trust strong{color:var(--ink);font-weight:500}
.trust a{text-decoration:underline;text-decoration-color:var(--rule);text-underline-offset:3px}
</style>`;

export function renderAuthForm(options: AuthFormOptions): Response {
  const isSignup = options.mode === "signup";
  const nextField = `<input type="hidden" name="next" value="${escapeHtml(options.next)}">`;
  const switchLink = isSignup
    ? `Already have an account? <a href="/login?next=${encodeURIComponent(options.next)}">Sign in</a>`
    : options.signupOpen
      ? `New here? <a href="/signup?next=${encodeURIComponent(options.next)}">Create your unicorn</a>`
      : "";
  const instance = options.instance;
  const trust = instance
    ? `<ul class="trust" aria-label="About this instance">
        <li>${icon("key")}<span><strong>Tokens encrypted per account.</strong> One database each; deleting the account deletes it.</span></li>
        <li>${icon("account")}<span><strong>Run by ${escapeHtml(instance.operator)}, no warranty.</strong> To keep tokens off this server, <a href="${escapeHtml(instance.repoUrl)}" target="_blank" rel="noopener">self-host the same code</a>.</span></li>
        <li>${icon("units")}<span><strong>Check your university's rules</strong> on using your own tokens with a third-party tool.</span></li>
      </ul>`
    : "";
  const body = `
    ${options.popup ? `<p class="notice" role="status">An app wants to connect to your unicorn. Sign in to continue.</p>` : ""}
    ${options.error ? `<p class="notice error" role="alert">${escapeHtml(options.error)}</p>` : ""}
    <form class="auth-form" method="post" action="/${isSignup ? "signup" : "login"}">
      ${nextField}
      <label class="field" for="email">Email</label>
      <input id="email" name="email" type="email" autocomplete="email" required value="${escapeHtml(options.email ?? "")}">
      <label class="field" for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="${isSignup ? "new-password" : "current-password"}" minlength="${isSignup ? 10 : 1}" required>
      ${isSignup && options.needsCode ? `<label class="field" for="code">Invite code</label><input id="code" name="code" type="text" autocomplete="off" required>` : ""}
      <button type="submit" class="lg auth-submit">${isSignup ? "Create account" : "Sign in"}${icon("arrow")}</button>
      ${isSignup ? `<p class="fine">Provided as is, without warranty. Delete everything any time from Account.</p>` : ""}
    </form>
    ${switchLink ? `<p class="auth-switch">${switchLink}</p>` : ""}
    ${options.popup ? "" : trust}
    ${AUTH_STYLE}`;
  const meta = instance
    ? `<span>Hosted by ${escapeHtml(instance.operator)} · ${instance.accounts} student${instance.accounts === 1 ? "" : "s"}</span><a href="${escapeHtml(instance.repoUrl)}" target="_blank" rel="noopener">Source</a>`
    : "";
  return htmlResponse(
    renderPage({
      title: isSignup ? "unicorn — create account" : "unicorn — sign in",
      active: "",
      heading: isSignup ? "Create your unicorn" : "Sign in",
      subtitle: isSignup ? "Then add a source token and paste one address into your AI. About five minutes." : "Opens your dashboard: what's due, every agent call, and what your agents remember.",
      body,
      // the OAuth pop-up is a small window: just the form
      layout: options.popup ? "bare" : "door",
      actions: meta,
    }),
    options.error ? 400 : 200,
  );
}

export interface AccountPageOptions {
  email: string;
  createdAt: string;
  csrf: string;
  notice?: string;
  error?: string;
}

export function renderAccountPage(options: AccountPageOptions): Response {
  const body = `
    ${options.notice ? `<p class="notice" role="status">${escapeHtml(options.notice)}</p>` : ""}
    ${options.error ? `<p class="notice error" role="alert">${escapeHtml(options.error)}</p>` : ""}
    <section class="card"><div class="card-head row" style="padding-bottom:18px;align-items:center"><div class="card-title"><span class="tile-mark md mono">${escapeHtml((options.email[0] ?? "?").toUpperCase())}</span><div><h2>${escapeHtml(options.email)}</h2><p class="card-sub" style="margin:0">Member since ${escapeHtml(options.createdAt.slice(0, 10))}</p></div></div>
      <form method="post" action="/logout" style="margin:0"><input type="hidden" name="csrf" value="${escapeHtml(options.csrf)}"><button type="submit" class="secondary">${icon("signout")}Sign out</button></form></div></section>
    <section class="card"><div class="card-head"><div class="card-title">${icon("key")}<h2>Personal access token</h2></div><p class="card-sub">The bearer token on Connect, for clients without OAuth. Rotating it disconnects anything using the old one; OAuth-connected apps are unaffected.</p></div>
      <div class="card-body"><form method="post" action="/account/rotate-token" style="display:flex;justify-content:flex-end;margin:0"><input type="hidden" name="csrf" value="${escapeHtml(options.csrf)}"><button type="submit" class="secondary">${icon("sync")}Rotate token</button></form></div></section>
    <section class="card danger-zone"><div class="card-head"><div class="card-title">${icon("alert")}<h2>Delete account</h2></div><p class="card-sub">Deletes your database (items, memory, plans, activity, encrypted source tokens), signs out every connected app, and removes your account. This cannot be undone.</p></div>
      <div class="card-body"><form method="post" action="/account/delete">
        <input type="hidden" name="csrf" value="${escapeHtml(options.csrf)}">
        <label class="field" for="confirm">Type your email to confirm</label>
        <input id="confirm" name="confirm" type="email" autocomplete="off" required>
        <div style="margin-top:14px;display:flex;justify-content:flex-end"><button type="submit" class="danger-solid">Delete everything</button></div>
      </form></div></section>
    <style>
      .danger-zone{border-color:color-mix(in srgb,var(--bad) 30%,var(--rule))}
      .danger-zone .card-title .i{color:var(--bad)}
      button.danger-solid{background:var(--bad);color:#fff;box-shadow:inset 0 1px 0 rgb(255 255 255/.14),0 1px 2px rgb(18 18 18/.2)}
      button.danger-solid:hover{background:color-mix(in srgb,var(--bad) 85%,#000)}
    </style>`;
  return htmlResponse(
    renderPage({ title: "unicorn — account", active: "/account", heading: "Account", subtitle: "Sign-in, the bearer token, and deleting your data.", body }),
    options.error ? 400 : 200,
  );
}
