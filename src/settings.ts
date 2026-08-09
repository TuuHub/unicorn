import { htmlResponse, renderPage } from "./ui";

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
    agent: boolean;
    notifier: boolean;
  };
  // Live operational state, fetched by the route handler: whether the hourly
  // scheduler alarm is set, and how many notifications have permanently failed.
  status: {
    schedulerRunning: boolean;
    failedNotifications: number;
    residentAgentEnabled: boolean;
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
    return htmlResponse(renderSettings(settings, runtime, new URL(request.url).searchParams.has("saved")));
  }

  if (request.method === "POST") {
    const url = new URL(request.url);
    if (request.headers.get("origin") !== url.origin) {
      return new Response("Invalid request origin.", { status: 403 });
    }
    const form = await request.formData();
    const retentionDays = Number(form.get("retentionDays"));
    if (!Number.isInteger(retentionDays) || retentionDays < 7 || retentionDays > 3650) {
      return htmlResponse(renderSettings(await runtime.repository.get(), runtime, false, "Retention must be between 7 and 3650 days."), 400);
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

function renderSettings(
  settings: AppSettings,
  runtime: Pick<SettingsRuntime, "connections" | "status">,
  saved: boolean,
  error?: string,
): string {
  const { connections, status } = runtime;
  const sources = [
    ["Moodle", connections.moodle],
    ["Ed Discussion", connections.ed],
    ["MCP", connections.mcp],
    ["Pi model", connections.agent],
    ["Notifier", connections.notifier],
  ] as const;
  const rail = sources
    .map(
      // "Configured" (the secret exists), not "Connected" — presence of a secret
      // says nothing about whether the credential still works upstream.
      ([name, configured]) => `<li class="source">
        <span class="dot ${configured ? "is-live" : "is-off"}" aria-hidden="true"></span>
        <span class="source-name" translate="no">${name}</span>
        <span class="source-state">${configured ? "Configured" : "Not configured"}</span>
      </li>`,
    )
    .join("");
  const schedulerRow = `<li class="source">
        <span class="dot ${status.schedulerRunning ? "is-live" : "is-off"}" aria-hidden="true"></span>
        <span class="source-name">Hourly scheduler</span>
        <span class="source-state">${status.schedulerRunning ? "Running" : "Stopped"}</span>
      </li>`;
  const agentRow = `<li class="source">
        <span class="dot ${status.residentAgentEnabled ? "is-live" : "is-off"}" aria-hidden="true"></span>
        <span class="source-name">Resident agent</span>
        <span class="source-state">${status.residentAgentEnabled ? "Enabled" : "Disabled"}</span>
      </li>`;
  const failedNotice =
    status.failedNotifications > 0
      ? `<p class="notice error" role="alert">${status.failedNotifications} notification${status.failedNotifications === 1 ? "" : "s"} permanently failed to deliver. Check the channel configuration, then re-save it and new messages will flow again.</p>`
      : "";
  const schedulerNotice = !status.schedulerRunning
    ? `<p class="notice error" role="alert">The hourly scheduler is not running — nothing will sync. Start it with <code>curl -X POST https://&lt;your-worker&gt;/schedule -H "Authorization: Bearer &lt;ADMIN_TOKEN&gt;"</code>.</p>`
    : "";
  const body = `
    ${saved ? '<p class="notice" role="status">Changes saved.</p>' : ""}
    ${error ? `<p class="notice error" role="alert">${error}</p>` : ""}
    ${schedulerNotice}
    ${failedNotice}
    <section class="card" aria-labelledby="connections-title">
      <div class="card-head"><h2 id="connections-title">Status</h2><p class="card-sub">Secrets are read from the Worker — configure with <code>wrangler secret put</code>, never stored here.</p></div>
      <div class="card-body"><ul class="rail rows">${schedulerRow}${agentRow}${rail}</ul></div>
    </section>
    <section class="card" aria-labelledby="behavior-title">
      <div class="card-head"><h2 id="behavior-title">Behavior</h2></div>
      <div class="card-body">
        <form method="post" action="/settings">
          <div class="rows">
            <div class="field">
              <div class="field-text"><label for="retentionDays">Hot retention window</label><p class="hint">Days before non-course items move to the archive.</p></div>
              <div class="field-input"><input id="retentionDays" name="retentionDays" type="number" inputmode="numeric" min="7" max="3650" required value="${settings.retentionDays}"><span class="unit">days</span></div>
            </div>
            <div class="field">
              <div class="field-text"><label for="syncEnabled">Source synchronization</label><p class="hint">Pull every enabled source on the hourly cycle.</p></div>
              <input id="syncEnabled" class="switch" name="syncEnabled" type="checkbox" ${settings.syncEnabled ? "checked" : ""}>
            </div>
            <div class="field">
              <div class="field-text"><label for="notificationsEnabled">Notifications</label><p class="hint">Deliver triage alerts and digests to configured channels.</p></div>
              <input id="notificationsEnabled" class="switch" name="notificationsEnabled" type="checkbox" ${settings.notificationsEnabled ? "checked" : ""}>
            </div>
          </div>
          <div class="actions"><button type="submit">Save changes</button></div>
        </form>
      </div>
    </section>
    <style>
      .rail{list-style:none;margin:0;padding:0}
      .source{display:flex;align-items:center;gap:10px;padding:12px 0}
      .dot{width:8px;height:8px;border-radius:50%;flex:none}
      .dot.is-live{background:var(--ok)}
      .dot.is-off{background:var(--track)}
      .source-name{font-weight:500}
      .source-state{margin-left:auto;color:var(--muted);font-size:13px;font-variant-numeric:tabular-nums}
      .field{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:14px 0}
      .field-text{min-width:0}
      label{font-weight:500;cursor:pointer}
      .hint{margin:1px 0 0;color:var(--muted);font-size:13px}
      .field-input{display:flex;align-items:center;gap:8px;flex:none}
      input[type=number]{width:84px;border:1px solid var(--border);background:var(--bg);color:var(--ink);padding:7px 10px;border-radius:8px;font:inherit;font-size:14px;font-variant-numeric:tabular-nums;text-align:right}
      .unit{color:var(--muted);font-size:13px}
      .switch{appearance:none;flex:none;width:38px;height:22px;margin:0;border-radius:999px;background:var(--track);cursor:pointer;position:relative;transition:background .15s ease-out}
      .switch::after{content:"";position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:translate .15s ease-out}
      .switch:checked{background:var(--ok)}
      .switch:checked::after{translate:16px 0}
      .actions{padding-top:16px;display:flex;justify-content:flex-end}
      @media (prefers-reduced-motion:reduce){.switch,.switch::after{transition:none}}
    </style>`;
  return renderPage({
    title: "unicorn settings",
    active: "/settings",
    heading: "Settings",
    subtitle: "Non-secret behavior for this Worker. Changes apply from the next cycle.",
    body,
  });
}
