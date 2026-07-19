import { D1JobStore, type AgentJobRun } from "./jobs/d1-job-store";

// ADR-0026: the digest is a rendered report, not a maintained surface. The HTML is
// produced from the latest completed run at request time and served as-is — no
// framework, no client state, linkable from a notification.
export async function renderDigestReport(db: D1Database): Promise<Response> {
  const runs = await new D1JobStore(db).listRuns("daily-digest", 1);
  const latest = runs.find((run) => run.status === "completed" && run.output);
  return html(page(latest));
}

function page(run: AgentJobRun | undefined): string {
  const body = run?.output
    ? `<article>${paragraphs(run.output)}</article><p class="meta">Generated ${escapeHtml(run.createdAt)} · ${run.totalTokens} tokens</p>`
    : `<p class="empty">No digest has been generated yet. Enable the <code>daily-digest</code> job and wait for the next scheduled run.</p>`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>unicorn digest</title>
  <style>
    :root { color-scheme: light dark; }
    body { margin:0; background:#f8fafc; color:#121722; font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    main { width:min(680px,calc(100% - 32px)); margin:clamp(28px,7vw,72px) auto; }
    h1 { font:800 clamp(30px,6vw,52px)/1 ui-rounded,"SF Pro Rounded",-apple-system,sans-serif; letter-spacing:-.05em; margin:0 0 24px; }
    article { background:#fff; border:1px solid #cbd3df; padding:22px 24px; }
    article p { margin:0 0 12px; }
    .meta { color:#667085; font:600 12px ui-monospace,SFMono-Regular,Menlo,monospace; margin-top:14px; }
    .empty { background:#fff; border:1px solid #cbd3df; padding:22px 24px; color:#667085; }
    code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
    @media (prefers-color-scheme: dark) { body { background:#0d1117; color:#e6edf3; } article,.empty { background:#161b22; border-color:#30363d; } }
  </style>
</head>
<body><main><h1>unicorn digest</h1>${body}</main></body>
</html>`;
}

function paragraphs(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((block) => `<p>${escapeHtml(block).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function html(body: string): Response {
  return new Response(body, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}
