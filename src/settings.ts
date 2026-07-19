export interface AppSettings {
  retentionDays: number;
  syncEnabled: boolean;
  notificationsEnabled: boolean;
}

export interface SettingsRepository {
  get(): Promise<AppSettings>;
  save(settings: AppSettings): Promise<void>;
}

export interface SettingsRuntime {
  adminToken: string;
  repository: SettingsRepository;
  connections: {
    moodle: boolean;
    ed: boolean;
    mcp: boolean;
    notifier: boolean;
  };
}

const DEFAULT_SETTINGS: AppSettings = {
  retentionDays: 180,
  syncEnabled: true,
  notificationsEnabled: true,
};

export class D1SettingsRepository implements SettingsRepository {
  constructor(private readonly db: D1Database) {}

  async get(): Promise<AppSettings> {
    const row = await this.db.prepare("SELECT value_json FROM settings WHERE key = 'app'").first<{ value_json: string }>();
    if (!row) {
      return { ...DEFAULT_SETTINGS };
    }
    return parseSettings(JSON.parse(row.value_json));
  }

  async save(settings: AppSettings): Promise<void> {
    const value = parseSettings(settings);
    await this.db
      .prepare(
        `INSERT INTO settings (key, value_json, updated_at)
         VALUES ('app', ?, ?)
         ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .bind(JSON.stringify(value), new Date().toISOString())
      .run();
  }
}

export async function handleSettings(request: Request, runtime: SettingsRuntime): Promise<Response> {
  if (!isBasicAuthorized(request.headers.get("authorization"), runtime.adminToken)) {
    return new Response("Authentication required.", {
      status: 401,
      headers: { "www-authenticate": 'Basic realm="unicorn settings", charset="UTF-8"' },
    });
  }

  if (request.method === "GET") {
    const settings = await runtime.repository.get();
    return html(renderSettings(settings, runtime.connections, new URL(request.url).searchParams.has("saved")));
  }

  if (request.method === "POST") {
    const url = new URL(request.url);
    if (request.headers.get("origin") !== url.origin) {
      return new Response("Invalid request origin.", { status: 403 });
    }
    const form = await request.formData();
    const retentionDays = Number(form.get("retentionDays"));
    if (!Number.isInteger(retentionDays) || retentionDays < 7 || retentionDays > 3650) {
      return html(renderSettings(await runtime.repository.get(), runtime.connections, false, "Retention must be between 7 and 3650 days."), 400);
    }
    await runtime.repository.save({
      retentionDays,
      syncEnabled: form.get("syncEnabled") === "on",
      notificationsEnabled: form.get("notificationsEnabled") === "on",
    });
    return new Response(null, { status: 303, headers: { location: "/settings?saved=1" } });
  }

  return new Response("Method not allowed.", { status: 405, headers: { allow: "GET, POST" } });
}

function parseSettings(value: unknown): AppSettings {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const retentionDays = Number(record.retentionDays);
  return {
    retentionDays: Number.isInteger(retentionDays) && retentionDays >= 7 && retentionDays <= 3650 ? retentionDays : DEFAULT_SETTINGS.retentionDays,
    syncEnabled: typeof record.syncEnabled === "boolean" ? record.syncEnabled : DEFAULT_SETTINGS.syncEnabled,
    notificationsEnabled:
      typeof record.notificationsEnabled === "boolean" ? record.notificationsEnabled : DEFAULT_SETTINGS.notificationsEnabled,
  };
}

export function isBasicAuthorized(header: string | null, token: string): boolean {
  if (!header?.startsWith("Basic ") || !token) {
    return false;
  }
  try {
    const decoded = atob(header.slice(6));
    const separator = decoded.indexOf(":");
    return separator !== -1 && decoded.slice(0, separator) === "unicorn" && constantTimeEqual(decoded.slice(separator + 1), token);
  } catch {
    return false;
  }
}

export function constantTimeEqual(left: string, right: string): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}

function renderSettings(
  settings: AppSettings,
  connections: SettingsRuntime["connections"],
  saved: boolean,
  error?: string,
): string {
  const sources = [
    ["Moodle", connections.moodle],
    ["Ed Discussion", connections.ed],
    ["MCP", connections.mcp],
    ["Notifier", connections.notifier],
  ] as const;
  const rail = sources
    .map(
      ([name, connected]) => `<li class="source ${connected ? "is-live" : "is-off"}">
        <span class="signal" aria-hidden="true"></span>
        <span>${name}</span>
        <strong>${connected ? "Connected" : "Not configured"}</strong>
      </li>`,
    )
    .join("");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>unicorn settings</title>
  <style>
    :root { color-scheme: light; --fog:#e9edf2; --paper:#f8fafc; --ink:#121722; --muted:#667085; --line:#cbd3df; --blue:#275efe; --coral:#ff5b45; --teal:#0b8f79; }
    * { box-sizing: border-box; }
    body { margin:0; background:var(--fog); color:var(--ink); font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    main { width:min(980px,calc(100% - 32px)); margin:clamp(28px,7vw,84px) auto; }
    header { display:grid; grid-template-columns:1fr auto; align-items:end; gap:24px; margin-bottom:28px; }
    .eyebrow { margin:0 0 7px; color:var(--blue); font:700 12px/1 ui-monospace,SFMono-Regular,Menlo,monospace; letter-spacing:.13em; text-transform:uppercase; }
    h1 { margin:0; font:800 clamp(36px,7vw,72px)/.94 ui-rounded,"SF Pro Rounded",-apple-system,sans-serif; letter-spacing:-.055em; }
    .stamp { border:1px solid var(--ink); padding:7px 10px; font:700 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace; text-transform:uppercase; }
    .layout { display:grid; grid-template-columns:minmax(250px,.75fr) minmax(0,1.45fr); gap:18px; }
    section { background:var(--paper); border:1px solid var(--line); }
    .panel-head { padding:18px 20px; border-bottom:1px solid var(--line); }
    h2 { margin:0; font-size:15px; letter-spacing:-.01em; }
    .rail { list-style:none; padding:14px 20px 16px; margin:0; }
    .source { position:relative; display:grid; grid-template-columns:14px 1fr; column-gap:12px; padding:11px 0; }
    .source:not(:last-child)::after { content:""; position:absolute; left:6px; top:28px; bottom:-7px; width:1px; background:var(--line); }
    .signal { width:13px; height:13px; margin-top:4px; border:3px solid var(--paper); outline:1px solid currentColor; border-radius:50%; background:currentColor; z-index:1; }
    .is-live .signal,.is-live strong { color:var(--teal); }
    .is-off .signal,.is-off strong { color:var(--coral); }
    .source strong { grid-column:2; font:600 11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace; }
    form { padding:20px; }
    label { display:block; font-weight:700; margin-bottom:8px; }
    .hint { margin:5px 0 0; color:var(--muted); font-size:13px; }
    input[type=number] { width:100%; border:1px solid var(--line); background:white; color:var(--ink); padding:11px 12px; font:600 15px ui-monospace,SFMono-Regular,Menlo,monospace; }
    .field { margin-bottom:22px; }
    .toggle { display:flex; align-items:flex-start; gap:10px; font-weight:600; }
    .toggle input { width:18px; height:18px; margin-top:3px; accent-color:var(--blue); }
    button { border:0; background:var(--blue); color:white; padding:12px 18px; font:750 14px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; cursor:pointer; }
    button:hover { background:#1648df; }
    :focus-visible { outline:3px solid var(--coral); outline-offset:3px; }
    .notice { margin:0 0 18px; padding:11px 14px; border-left:4px solid var(--teal); background:#e0f4ef; }
    .error { border-color:var(--coral); background:#ffe8e4; }
    footer { margin-top:16px; color:var(--muted); font-size:12px; }
    code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
    @media (max-width:720px) { header { grid-template-columns:1fr; } .stamp { justify-self:start; } .layout { grid-template-columns:1fr; } }
    @media (prefers-reduced-motion:no-preference) { .signal { transition:transform .2s ease; } .source:hover .signal { transform:scale(1.2); } }
  </style>
</head>
<body>
  <main>
    <header><div><p class="eyebrow">Single-worker control plane</p><h1>unicorn</h1></div><span class="stamp">self-hosted</span></header>
    ${saved ? '<p class="notice" role="status">Changes saved.</p>' : ""}
    ${error ? `<p class="notice error" role="alert">${error}</p>` : ""}
    <div class="layout">
      <section aria-labelledby="connections-title"><div class="panel-head"><h2 id="connections-title">Connection rail</h2></div><ul class="rail">${rail}</ul></section>
      <section aria-labelledby="behavior-title"><div class="panel-head"><h2 id="behavior-title">Behavior</h2></div>
        <form method="post" action="/settings">
          <div class="field"><label for="retentionDays">Hot retention window</label><input id="retentionDays" name="retentionDays" type="number" min="7" max="3650" required value="${settings.retentionDays}"><p class="hint">Days before non-course items move to the archive.</p></div>
          <div class="field"><label class="toggle"><input name="syncEnabled" type="checkbox" ${settings.syncEnabled ? "checked" : ""}><span>Run source synchronization</span></label></div>
          <div class="field"><label class="toggle"><input name="notificationsEnabled" type="checkbox" ${settings.notificationsEnabled ? "checked" : ""}><span>Send configured notifications</span></label></div>
          <button type="submit">Save changes</button>
        </form>
      </section>
    </div>
    <footer>Secrets are never rendered here. Configure them with <code>wrangler secret put</code> or the deployment workflow.</footer>
  </main>
</body>
</html>`;
}
