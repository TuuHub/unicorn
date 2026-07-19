// Shared shell for the two rendered report pages (/settings, /digest).
// Plain HTML+CSS strings by design (ADR-0026): zero framework, zero client state.

const NAV = [
  { path: "/settings", label: "Settings" },
  { path: "/digest", label: "Digest" },
] as const;

export interface PageOptions {
  title: string;
  active: "/settings" | "/digest";
  heading: string;
  subtitle: string;
  body: string;
}

const CSS = `
:root{color-scheme:light dark;--bg:#fafafa;--card:#ffffff;--border:#e4e4e7;--track:#d4d4d8;--ink:#18181b;--muted:#71717a;--accent:#2563eb;--ok:#16a34a;--btn-bg:#18181b;--btn-ink:#ffffff;--btn-hover:#3f3f46}
@media (prefers-color-scheme:dark){:root{--bg:#111113;--card:#1b1b1f;--border:#2b2b30;--track:#3f3f46;--ink:#f4f4f5;--muted:#9f9fa8;--accent:#7aa2ff;--ok:#4ade80;--btn-bg:#f4f4f5;--btn-ink:#18181b;--btn-hover:#d4d4d8}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
main{width:min(680px,calc(100% - 40px));margin:0 auto;padding:40px 0 72px}
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
`;

export function renderPage(options: PageOptions): string {
  const nav = NAV.map(
    (page) =>
      `<a href="${page.path}"${page.path === options.active ? ' aria-current="page"' : ""}>${page.label}</a>`,
  ).join("");
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
  <main>
    <header><span class="brand" translate="no">unicorn</span><nav>${nav}</nav></header>
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
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
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
