// Pages only the hosted server has (ADR-0046): the public landing page, sign-up / sign-in (also
// shown inside the OAuth pop-up a connector opens), and the account page. Everything after sign-in
// is the shared panel and /settings from src/.

import { escapeHtml, htmlResponse, renderPage } from "../src/ui";

export interface LandingOptions {
  signedIn: boolean;
  operator: string;
  accounts: number;
  signupOpen: boolean;
  repoUrl: string;
}

const LANDING_CSS = `
:root{color-scheme:light dark;--bg:#fbfaf7;--ink:#17161a;--muted:#6c6a73;--card:#ffffff;--border:#e7e4dd;--accent:#5b4bdb;--accent-ink:#fff;--soft:#f1eefc}
@media (prefers-color-scheme:dark){:root{--bg:#121116;--ink:#f3f2f6;--muted:#a09eaa;--card:#1b1a21;--border:#2c2a33;--accent:#9d90ff;--accent-ink:#121116;--soft:#221f33}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif;-webkit-font-smoothing:antialiased}
a{color:inherit}
.wrap{width:min(1080px,calc(100% - 32px));margin:0 auto}
header.top{display:flex;justify-content:space-between;align-items:center;padding:22px 0}
.logo{font-weight:700;letter-spacing:-.02em;text-decoration:none;font-size:17px}
.top nav a{margin-left:18px;text-decoration:none;color:var(--muted);font-size:14.5px}
.top nav a.cta{color:var(--accent-ink);background:var(--accent);padding:8px 16px;border-radius:999px;font-weight:600}
.hero{padding:72px 0 56px;text-align:center}
.eyebrow{display:inline-block;font-size:13px;color:var(--accent);background:var(--soft);padding:4px 12px;border-radius:999px;margin-bottom:18px;font-weight:600}
h1{font-size:clamp(34px,6vw,58px);line-height:1.05;letter-spacing:-.035em;margin:0 auto 18px;max-width:820px;text-wrap:balance}
.lede{font-size:clamp(17px,2.2vw,20px);color:var(--muted);max-width:680px;margin:0 auto 32px;text-wrap:balance}
.ctas{display:flex;gap:12px;justify-content:center;flex-wrap:wrap}
.btn{display:inline-block;padding:13px 22px;border-radius:12px;font-weight:600;text-decoration:none;font-size:15.5px;border:1px solid var(--border)}
.btn.primary{background:var(--accent);color:var(--accent-ink);border-color:var(--accent)}
.fine{color:var(--muted);font-size:13.5px;margin-top:14px}
section{padding:48px 0}
h2{font-size:clamp(24px,3.4vw,34px);letter-spacing:-.025em;margin:0 0 10px;text-wrap:balance}
.section-lede{color:var(--muted);margin:0 0 28px;max-width:640px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px}
.card{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:20px}
.card h3{margin:0 0 6px;font-size:16.5px;letter-spacing:-.01em}
.card p{margin:0;color:var(--muted);font-size:14.5px}
.ask{font-style:italic;color:var(--ink)!important;margin-bottom:6px!important}
.steps{counter-reset:s;display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px}
.steps .card::before{counter-increment:s;content:counter(s);display:grid;place-items:center;width:30px;height:30px;border-radius:999px;background:var(--soft);color:var(--accent);font-weight:700;margin-bottom:12px}
pre.mem{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:18px;font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-x:auto;white-space:pre-wrap;margin:0}
.split{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:28px;align-items:center}
.trust li{margin:8px 0;color:var(--muted)}
.trust strong{color:var(--ink)}
footer{border-top:1px solid var(--border);padding:28px 0 48px;color:var(--muted);font-size:13.5px;display:flex;justify-content:space-between;flex-wrap:wrap;gap:12px}
`;

export function renderLanding(options: LandingOptions): Response {
  const primary = options.signedIn
    ? `<a class="btn primary" href="/panel">Open your dashboard</a>`
    : options.signupOpen
      ? `<a class="btn primary" href="/signup">Create your unicorn — free</a>`
      : `<a class="btn primary" href="/login">Sign in</a>`;
  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>unicorn — a memory of your campus for the AI you already use</title>
<meta name="description" content="unicorn reads Ed, Moodle, Canvas and Gmail every hour and gives Claude, ChatGPT and Claude Code a memory of your courses: what changed, what's due, and who you are.">
<style>${LANDING_CSS}</style>
</head><body>
<div class="wrap">
  <header class="top"><a class="logo" href="/">🦄 unicorn</a><nav>${
    options.signedIn
      ? `<a href="/panel">Dashboard</a><a href="/account">Account</a>`
      : `<a href="#how">How it works</a><a href="/login">Sign in</a>${options.signupOpen ? `<a class="cta" href="/signup">Get started</a>` : ""}`
  }</nav></header>

  <div class="hero">
    <span class="eyebrow">Remote MCP · Claude · ChatGPT · Claude Code</span>
    <h1>Give your AI a memory of your campus.</h1>
    <p class="lede">unicorn reads Ed, Moodle, Canvas and Gmail every hour and remembers what each one said. Your AI can then tell you what changed, what's due, and see one unit across every system — and it remembers you between chats.</p>
    <div class="ctas">${primary}<a class="btn" href="${escapeHtml(options.repoUrl)}" target="_blank" rel="noopener">Self-host instead</a></div>
    <p class="fine">Sign up, paste two tokens, click Connect in Claude. About five minutes.</p>
  </div>

  <section>
    <h2>Ask it like you'd ask a friend who reads everything.</h2>
    <p class="section-lede">unicorn has no model of its own. The AI you already pay for does the thinking; unicorn gives it the facts and the history.</p>
    <div class="grid">
      ${feature("“What changed since Tuesday?”", "Every new post, moved deadline and released grade, in order — across all your units.")}
      ${feature("“What's due in the next week?”", "Deadlines from Moodle, Canvas and Ed together, in your timezone, with links.")}
      ${feature("“Show me everything for FIT2004.”", "One unit joined across systems: the spec on Moodle next to staff answers on Ed.")}
      ${feature("“Plan my week.”", "A day-by-day plan saved in unicorn, so your laptop and your phone see the same one.")}
      ${feature("“I was sick, catch me up.”", "What needs action now, what to read soon, and a recovery plan.")}
      ${feature("“Help me prep for the exam.”", "Exam facts with sources, staff hints, and a revision plan up to the day.")}
    </div>
  </section>

  <section id="how">
    <h2>Three steps. No terminal.</h2>
    <div class="steps">
      <div class="card"><h3>Create your unicorn</h3><p>An email and a password. You get your own private database — nobody else's data shares it.</p></div>
      <div class="card"><h3>Add your sources</h3><p>Paste an Ed API token and a Canvas token; Moodle takes a session cookie or one helper command. unicorn syncs every hour.</p></div>
      <div class="card"><h3>Connect your AI</h3><p>Paste your unicorn address into Claude, ChatGPT or Claude Code. A pop-up asks you to sign in. Done.</p></div>
    </div>
  </section>

  <section>
    <div class="split">
      <div>
        <h2>It remembers you, not just your units.</h2>
        <p class="section-lede">Your AI keeps a small memory in unicorn — who you are, what you're following up, how you like plans. Every new chat, on any device, in any app, starts by reading it. You can read and edit every line in your dashboard.</p>
        <p class="section-lede">When a new term starts, unicorn notices the new units on its own and your AI asks you about them.</p>
      </div>
      <pre class="mem" aria-label="Example memory">USER PROFILE  [31% — 430/1400]
Year 3 Bachelor of IT, major in software dev
§
Goal this term: HD in FIT3175; pass FIT2004 comfortably
§
Prefers day-by-day checklists; no work on Sundays

NOTES  [18% — 396/2200]
2026-11-04: emailed tutor about A2 extension — waiting
§
FIT2004 exam closed book; weak on DP, revise first

TERM  (kept by unicorn)
- FIT3175 — Usability (Moodle, Ed)
- FIT2004 — Algorithms and data structures (Moodle, Ed)</pre>
    </div>
  </section>

  <section>
    <div class="split">
      <div>
        <h2>See everything it does.</h2>
        <p class="section-lede">Your dashboard logs every call an AI makes to unicorn — which app, which tool, which arguments, how long it took — and every sync unicorn runs against your sources. Nothing happens out of sight.</p>
      </div>
      <ul class="trust">
        <li><strong>Read-only on your sources.</strong> unicorn never posts, submits or replies anywhere.</li>
        <li><strong>Encrypted tokens.</strong> Source credentials are encrypted at rest with a key unique to your account.</li>
        <li><strong>One database per person.</strong> Delete your account and your database file is deleted with it.</li>
        <li><strong>Hosted by ${escapeHtml(options.operator)}, as is.</strong> This is a community-run instance with no warranty. If you would rather nobody else holds your tokens, <a href="${escapeHtml(options.repoUrl)}" target="_blank" rel="noopener">self-host the same code</a> on your own free Cloudflare account.</li>
        <li><strong>Your university's rules apply.</strong> Check that using your own access tokens with a third-party tool is allowed where you study.</li>
      </ul>
    </div>
  </section>

  <footer><span>🦄 unicorn · Apache-2.0 · ${options.accounts} student${options.accounts === 1 ? "" : "s"} on this instance</span><span><a href="${escapeHtml(options.repoUrl)}" target="_blank" rel="noopener">GitHub</a> · <a href="https://unicorn.tuuhub.com/docs/unicorn" target="_blank" rel="noopener">Docs</a></span></footer>
</div>
</body></html>`;
  return htmlResponse(html);
}

function feature(ask: string, answer: string): string {
  return `<div class="card"><p class="ask">${escapeHtml(ask)}</p><p>${escapeHtml(answer)}</p></div>`;
}

export interface AuthFormOptions {
  mode: "login" | "signup";
  next: string;
  error?: string;
  email?: string;
  signupOpen: boolean;
  needsCode: boolean;
  popup: boolean;
}

export function renderAuthForm(options: AuthFormOptions): Response {
  const isSignup = options.mode === "signup";
  const nextField = `<input type="hidden" name="next" value="${escapeHtml(options.next)}">`;
  const switchLink = isSignup
    ? `Already have an account? <a href="/login?next=${encodeURIComponent(options.next)}">Sign in</a>`
    : options.signupOpen
      ? `New here? <a href="/signup?next=${encodeURIComponent(options.next)}">Create your unicorn</a>`
      : "";
  const body = `
    ${options.popup ? `<p class="notice">An app wants to connect to your unicorn. Sign in to continue.</p>` : ""}
    ${options.error ? `<p class="notice error" role="alert">${escapeHtml(options.error)}</p>` : ""}
    <section class="card"><div class="card-body" style="padding-top:18px">
      <form method="post" action="/${isSignup ? "signup" : "login"}">
        ${nextField}
        <label class="field" for="email">Email</label>
        <input id="email" name="email" type="email" autocomplete="email" required value="${escapeHtml(options.email ?? "")}">
        <label class="field" for="password">Password</label>
        <input id="password" name="password" type="password" autocomplete="${isSignup ? "new-password" : "current-password"}" minlength="${isSignup ? 10 : 1}" required>
        ${isSignup && options.needsCode ? `<label class="field" for="code">Invite code</label><input id="code" name="code" type="text" autocomplete="off" required>` : ""}
        ${isSignup ? `<p class="muted" style="font-size:12.5px;margin:12px 0 0">By creating an account you accept that this is a community-hosted instance provided as is, without warranty. Your source tokens are stored encrypted; you can delete everything at any time from Account.</p>` : ""}
        <div style="margin-top:16px;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
          <span class="muted" style="font-size:13.5px">${switchLink}</span>
          <button type="submit">${isSignup ? "Create account" : "Sign in"}</button>
        </div>
      </form>
    </div></section>`;
  return htmlResponse(
    renderPage({
      title: isSignup ? "unicorn — create account" : "unicorn — sign in",
      active: "",
      heading: isSignup ? "Create your unicorn" : "Sign in",
      subtitle: isSignup ? "Your own private campus memory, ready for Claude, ChatGPT and Claude Code." : "Welcome back.",
      body,
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
    ${options.notice ? `<p class="notice">${escapeHtml(options.notice)}</p>` : ""}
    ${options.error ? `<p class="notice error" role="alert">${escapeHtml(options.error)}</p>` : ""}
    <section class="card"><div class="card-head"><h2>Signed in as ${escapeHtml(options.email)}</h2><p class="card-sub">Member since ${escapeHtml(options.createdAt.slice(0, 10))}</p></div>
      <div class="card-body"><form method="post" action="/logout"><input type="hidden" name="csrf" value="${escapeHtml(options.csrf)}"><button type="submit" class="secondary">Sign out</button></form></div></section>
    <section class="card"><div class="card-head"><h2>Personal access token</h2><p class="card-sub">The bearer token on Connect, for clients without OAuth. Rotating it disconnects anything using the old one; OAuth-connected apps are unaffected.</p></div>
      <div class="card-body"><form method="post" action="/account/rotate-token"><input type="hidden" name="csrf" value="${escapeHtml(options.csrf)}"><button type="submit" class="secondary">Rotate token</button></form></div></section>
    <section class="card"><div class="card-head"><h2>Delete account</h2><p class="card-sub">Deletes your database (items, memory, plans, activity, encrypted source tokens), signs out every connected app, and removes your account. This cannot be undone.</p></div>
      <div class="card-body"><form method="post" action="/account/delete">
        <input type="hidden" name="csrf" value="${escapeHtml(options.csrf)}">
        <label class="field" for="confirm">Type your email to confirm</label>
        <input id="confirm" name="confirm" type="email" autocomplete="off" required>
        <div style="margin-top:12px;display:flex;justify-content:flex-end"><button type="submit">Delete everything</button></div>
      </form></div></section>`;
  return htmlResponse(
    renderPage({ title: "unicorn — account", active: "/account", heading: "Account", subtitle: "Your unicorn on this hosted instance.", body }),
    options.error ? 400 : 200,
  );
}
