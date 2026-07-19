import { D1JobStore, type AgentJobRun } from "./jobs/d1-job-store";
import { escapeHtml, htmlResponse, renderPage } from "./ui";

// ADR-0026: the digest is a rendered report, not a maintained surface. The HTML is
// produced from the latest completed run at request time and served as-is — no
// framework, no client state, linkable from a notification.
export async function renderDigestReport(db: D1Database): Promise<Response> {
  // Scan recent runs, not just the latest: a later no_changes or failed run must not
  // hide the last digest the user actually received.
  const runs = await new D1JobStore(db).listRuns("daily-digest", 30);
  const latest = runs.find((run) => run.status === "completed" && run.output);
  return htmlResponse(page(latest));
}

function page(run: AgentJobRun | undefined): string {
  const body = run?.output
    ? `<article class="card"><div class="card-body digest-body">${paragraphs(run.output)}</div></article>
       <p class="meta">Generated ${escapeHtml(formatTimestamp(run.createdAt))} · ${run.totalTokens.toLocaleString("en-US")}&nbsp;tokens</p>`
    : `<div class="card"><div class="card-body empty">
         <p><strong>No digest yet.</strong></p>
         <p>Enable the <code>daily-digest</code> job through the <code>configure_agent_job</code> MCP tool and the next scheduled run will appear here.</p>
       </div></div>`;
  return renderPage({
    title: "unicorn digest",
    active: "/digest",
    heading: "Daily digest",
    subtitle: "The most recent completed digest run, rendered as-is.",
    body: `${body}
    <style>
      .digest-body{padding-top:16px;font-size:15px}
      .digest-body p{margin:0 0 12px}
      .digest-body p:last-child{margin-bottom:0}
      .meta{color:var(--muted);font:500 12.5px ui-monospace,SFMono-Regular,Menlo,monospace;font-variant-numeric:tabular-nums}
      .empty{padding-top:16px;color:var(--muted)}
      .empty p{margin:0 0 8px}
      .empty strong{color:var(--ink)}
    </style>`,
  });
}

// Digest timestamps are ISO strings written by the job store; fall back to the raw
// value if a run predates that format.
function formatTimestamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
    hour12: false,
  }).format(parsed) + " UTC";
}

function paragraphs(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((block) => `<p>${escapeHtml(block).replace(/\n/g, "<br>")}</p>`)
    .join("");
}
