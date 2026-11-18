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
        <li>${icon("check")}<span><strong>Read-only.</strong> Nothing is ever posted, submitted or sent from your accounts.</span></li>
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
    ? `Hosted by ${escapeHtml(instance.operator)} · ${instance.accounts} student${instance.accounts === 1 ? "" : "s"}`
    : "";
  return htmlResponse(
    renderPage({
      title: isSignup ? "unicorn — create account" : "unicorn — sign in",
      active: "",
      heading: isSignup ? "Create your unicorn" : "Sign in to unicorn",
      subtitle: isSignup ? "Next: add a source token, then paste one address into Claude, ChatGPT or Claude Code." : "Deadlines across your units, every call your agents made, and what they remember about you.",
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
  const csrf = `<input type="hidden" name="csrf" value="${escapeHtml(options.csrf)}">`;
  const body = `
    ${options.notice ? `<p class="notice" role="status">${escapeHtml(options.notice)}</p>` : ""}
    ${options.error ? `<p class="notice error" role="alert">${escapeHtml(options.error)}</p>` : ""}
    <div class="settings">
      <div class="setting">
        <div class="setting-text"><h3>Signed in as</h3><p>Member since ${escapeHtml(options.createdAt.slice(0, 10))}.</p></div>
        <div class="setting-control"><div class="identity"><span class="tile-mark md mono">${escapeHtml((options.email[0] ?? "?").toUpperCase())}</span><span class="truncate">${escapeHtml(options.email)}</span><form method="post" action="/logout" style="margin:0 0 0 auto">${csrf}<button type="submit" class="secondary sm">${icon("signout")}Sign out</button></form></div></div>
      </div>
      <div class="setting">
        <div class="setting-text"><h3>Personal access token</h3><p>The bearer token on Connect, for clients without OAuth. Rotating it disconnects anything using the old one; OAuth-connected apps stay connected.</p></div>
        <div class="setting-control"><form method="post" action="/account/rotate-token" style="margin:0">${csrf}<button type="submit" class="secondary">${icon("sync")}Rotate token</button></form></div>
      </div>
      <div class="setting">
        <div class="setting-text"><h3>Your data</h3><p>One SQLite file on this server, separate from every other account. Source tokens in it are encrypted with a key derived for your account; the operator can still read synced items, memory and plans. Self-host if that matters to you.</p></div>
        <div class="setting-control"><a class="button secondary" href="/panel/export" download>${icon("download")}Export as JSON</a><p class="hint">Memory, plans, briefs and recent activity.</p></div>
      </div>
      <div class="setting">
        <div class="setting-text"><h3 class="danger-title">Delete account</h3><p>Deletes your database (items, memory, plans, activity, encrypted source tokens), signs out every connected app, and removes your account. This cannot be undone.</p></div>
        <div class="setting-control"><form method="post" action="/account/delete" style="margin:0">${csrf}
          <input id="confirm" name="confirm" type="email" autocomplete="off" required placeholder="Type your email to confirm" aria-label="Type your email to confirm">
          <div class="setting-actions"><button type="submit" class="danger-solid">Delete everything</button></div>
        </form></div>
      </div>
    </div>
    <style>
      .identity{display:flex;align-items:center;gap:12px;width:100%;padding:8px 8px 8px 10px;border-radius:14px;background:var(--surface);box-shadow:var(--shadow)}
      .danger-title{color:var(--danger-text)}
      button.danger-solid{background:var(--danger);color:#fff}
      button.danger-solid:hover{background:color-mix(in oklab,var(--danger) 88%,#000)}
    </style>`;
  return htmlResponse(
    renderPage({ title: "unicorn — account", active: "/account", heading: "Account", subtitle: "Sign-in, the bearer token, where your data lives, and deleting it.", body }),
    options.error ? 400 : 200,
  );
}
