// Shared shell for every rendered page: the panel (ADR-0048) and /settings.
// Plain HTML+CSS strings by design (ADR-0026): zero framework, zero client state.

interface NavLink {
  path: string;
  label: string;
}

const NAV: NavLink[] = [
  { path: "/panel", label: "Overview" },
  { path: "/panel/activity", label: "Activity" },
  { path: "/panel/memory", label: "Memory" },
  { path: "/panel/connect", label: "Connect" },
  { path: "/settings", label: "Sources" },
];

// The hosted server (ADR-0046) adds its account links once at startup; a self-deployed Worker
// never calls this. Module-level on purpose: one process serves one deployment mode.
let extraNav: NavLink[] = [];
let brandHref = "/panel";

export function configureChrome(options: { extraNav?: NavLink[]; brandHref?: string }): void {
  extraNav = options.extraNav ?? [];
  brandHref = options.brandHref ?? "/panel";
}

export interface PageOptions {
  title: string;
  active: string;
  heading: string;
  subtitle: string;
  body: string;
  // /settings has enough side-by-side content (source cards) to earn a wider
  // column than /digest's read-through text; /digest keeps the narrower default.
  wide?: boolean;
}

const CSS = `
:root{color-scheme:light dark;--bg:#fafafa;--card:#ffffff;--border:#e4e4e7;--track:#d4d4d8;--ink:#18181b;--muted:#71717a;--accent:#2563eb;--ok:#16a34a;--btn-bg:#18181b;--btn-ink:#ffffff;--btn-hover:#3f3f46}
@media (prefers-color-scheme:dark){:root{--bg:#111113;--card:#1b1b1f;--border:#2b2b30;--track:#3f3f46;--ink:#f4f4f5;--muted:#9f9fa8;--accent:#7aa2ff;--ok:#4ade80;--btn-bg:#f4f4f5;--btn-ink:#18181b;--btn-hover:#d4d4d8}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
main{width:min(680px,calc(100% - 40px));margin:0 auto;padding:40px 0 72px}
main.wide{width:min(960px,calc(100% - 48px))}
a{color:inherit;text-decoration:none;touch-action:manipulation}
header{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:32px}
.brand{font-weight:650;font-size:16px;letter-spacing:-.02em}
nav{display:flex;gap:4px;background:var(--card);border:1px solid var(--border);border-radius:999px;padding:3px}
nav a{padding:5px 14px;border-radius:999px;font-size:13px;font-weight:500;color:var(--muted);transition:color .15s ease-out,background .15s ease-out}
nav a:hover{color:var(--ink)}
nav a[aria-current=page]{background:var(--btn-bg);color:var(--btn-ink)}
h1{margin:0 0 4px;font-size:22px;font-weight:650;letter-spacing:-.02em;text-wrap:balance}
.sub{margin:0 0 24px;color:var(--muted);font-size:14px}
.card{background:var(--card);border:1px solid var(--border);border-radius:12px;margin-bottom:16px}
.card-head{padding:16px 20px 0}
h2{margin:0;font-size:15px;font-weight:600;letter-spacing:-.01em}
.card-sub{margin:2px 0 0;color:var(--muted);font-size:13px}
.card-body{padding:8px 20px 20px}
.rows>*{border-top:1px solid var(--border)}
.rows>:first-child{border-top:0}
.notice{margin:0 0 16px;padding:10px 14px;border:1px solid rgba(34,197,94,.35);background:rgba(34,197,94,.1);border-radius:10px;font-size:14px}
.notice.error{border-color:rgba(239,68,68,.4);background:rgba(239,68,68,.1)}
button{border:0;border-radius:8px;background:var(--btn-bg);color:var(--btn-ink);padding:8px 16px;font:inherit;font-size:14px;font-weight:550;cursor:pointer;touch-action:manipulation;transition:background .15s ease-out,transform .1s ease-out}
button:hover{background:var(--btn-hover)}
button:active{transform:scale(.97)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
footer{margin-top:24px;color:var(--muted);font-size:12.5px;text-align:center}
code{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--card);border:1px solid var(--border);border-radius:5px;padding:1px 5px}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
nav{flex-wrap:wrap}
.brand a{display:inline-flex;align-items:center;gap:6px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:16px}
.tile{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:14px 16px}
.tile .label{color:var(--muted);font-size:12.5px}
.tile .value{font-size:24px;font-weight:650;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.tile .hint{color:var(--muted);font-size:12px}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px}
.grid2>.card{margin-bottom:0}
.list{list-style:none;margin:0;padding:0}
.list li{display:flex;justify-content:space-between;gap:12px;padding:9px 0;border-top:1px solid var(--border);font-size:14px}
.list li:first-child{border-top:0}
.list .muted,.muted{color:var(--muted)}
.badge{display:inline-block;font-size:11.5px;font-weight:600;padding:1px 8px;border-radius:999px;border:1px solid var(--border);color:var(--muted);white-space:nowrap}
.badge.ok{color:var(--ok);border-color:currentColor}
.badge.error{color:#ef4444;border-color:currentColor}
.badge.tool{color:var(--accent);border-color:currentColor}
.table-wrap{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:13.5px}
th{text-align:left;font-weight:550;color:var(--muted);font-size:12px;padding:8px 10px;border-bottom:1px solid var(--border);white-space:nowrap}
td{padding:9px 10px;border-bottom:1px solid var(--border);vertical-align:top}
td.num{font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}
details summary{cursor:pointer;color:var(--muted);font-size:12.5px}
pre{font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:10px;overflow-x:auto;white-space:pre-wrap;word-break:break-word;margin:6px 0 0}
textarea{width:100%;min-height:140px;font:13px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--bg);color:var(--ink);border:1px solid var(--border);border-radius:8px;padding:10px}
input[type=text],input[type=email],input[type=password]{width:100%;font:inherit;background:var(--bg);color:var(--ink);border:1px solid var(--border);border-radius:8px;padding:9px 12px}
label.field{display:block;font-size:13px;font-weight:550;margin:12px 0 6px}
.meter{height:6px;background:var(--track);border-radius:999px;overflow:hidden;margin:8px 0 2px}
.meter>span{display:block;height:100%;background:var(--accent)}
.meter.warn>span{background:#f59e0b}
.filters{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px}
.filters a{font-size:13px;padding:4px 12px;border:1px solid var(--border);border-radius:999px;color:var(--muted)}
.filters a[aria-current=true]{background:var(--btn-bg);color:var(--btn-ink);border-color:var(--btn-bg)}
.steps{counter-reset:step;list-style:none;margin:0;padding:0}
.steps li{counter-increment:step;position:relative;padding:8px 0 8px 34px;font-size:14px}
.steps li::before{content:counter(step);position:absolute;left:0;top:8px;width:22px;height:22px;border-radius:999px;border:1px solid var(--border);display:grid;place-items:center;font-size:12px;color:var(--muted)}
.steps li.done::before{content:"✓";background:var(--ok);border-color:var(--ok);color:#fff}
.copy-row{display:flex;gap:8px;align-items:center;margin:8px 0}
.copy-row code{flex:1;padding:8px 10px;overflow-x:auto;white-space:nowrap}
.button,a.button{display:inline-block;border:0;border-radius:8px;background:var(--btn-bg);color:var(--btn-ink);padding:8px 16px;font-size:14px;font-weight:550}
.button.secondary,button.secondary{background:transparent;color:var(--ink);border:1px solid var(--border)}
.pager{display:flex;justify-content:flex-end;margin-top:12px}
.card-body a:not(.button),.card-sub a,.steps a,.notice a{color:var(--accent);text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:2px}
`;

export function renderPage(options: PageOptions): string {
  const nav = [...NAV, ...extraNav]
    .map((page) => `<a href="${page.path}"${page.path === options.active ? ' aria-current="page"' : ""}>${page.label}</a>`)
    .join("");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="#fafafa" media="(prefers-color-scheme: light)">
  <meta name="theme-color" content="#111113" media="(prefers-color-scheme: dark)">
  <title>${options.title}</title>
  <style>${CSS}</style>
</head>
<body>
  <main${options.wide ? ' class="wide"' : ""}>
    <header><span class="brand" translate="no"><a href="${brandHref}">🦄 unicorn</a></span><nav>${nav}</nav></header>
    <h1>${options.heading}</h1>
    <p class="sub">${options.subtitle}</p>
    ${options.body}
  </main>
</body>
</html>`;
}

export function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      // script-src is inline-only, no external hosts: /settings' progressive
      // enhancement (copy buttons, timezone auto-detect) is the only script on
      // any page, and CSS-var theming needs style-src unsafe-inline too.
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      // "same-origin", not "no-referrer": since Chrome 85 the Origin header on
      // same-origin form POSTs honors the referrer policy, and "no-referrer"
      // serializes it to "null" — which would make the /settings CSRF origin
      // check reject every real browser submission.
      "referrer-policy": "same-origin",
      "x-content-type-options": "nosniff",
      // This page carries ADMIN_TOKEN-gated state and CSRF-protected forms —
      // never cache it, and never let a browser fall back to plain HTTP for it.
      "strict-transport-security": "max-age=63072000; includeSubDomains",
      "cache-control": "no-store",
    },
  });
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
