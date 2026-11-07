// Shared shell for every rendered page: the panel (ADR-0048), /settings, the OAuth consent page
// and the hosted server's sign-in. Plain HTML+CSS strings by design (ADR-0026): zero framework,
// zero client state, nothing loaded from anywhere else.
//
// The look follows HeroUI v3's dashboard templates: a grey canvas, white surfaces lifted by a
// hairline shadow, pill controls, soft chips and one blue accent. Source hues stay the landing
// page's spectrum; the sign-in keeps its hero horn.

import { HORN_FALLBACK, HORN_SCRIPT } from "./horn";
import { icon } from "./marks";

interface NavLink {
  path: string;
  label: string;
  icon?: Parameters<typeof icon>[0];
}

const NAV_GROUPS: Array<{ label: string; links: NavLink[] }> = [
  {
    label: "Campus",
    links: [
      { path: "/panel", label: "Overview", icon: "overview" },
      { path: "/panel/changes", label: "Changes", icon: "changes" },
      { path: "/panel/due", label: "Deadlines", icon: "calendar" },
      { path: "/panel/units", label: "Units", icon: "units" },
      { path: "/panel/briefs", label: "Briefs", icon: "brief" },
      { path: "/panel/plans", label: "Plans", icon: "plan" },
    ],
  },
  {
    label: "Agents",
    links: [
      { path: "/panel/activity", label: "Activity", icon: "activity" },
      { path: "/panel/memory", label: "Memory", icon: "memory" },
      { path: "/panel/playbooks", label: "Playbooks", icon: "playbook" },
      { path: "/panel/connect", label: "Connect", icon: "connect" },
    ],
  },
];

const SITE = "https://unicorn.tuuhub.com";
const DOCS = `${SITE}/docs/unicorn`;

// The hosted server (ADR-0046) adds its account links once at startup; a self-deployed Worker
// never calls this. Module-level on purpose: one process serves one deployment mode.
// A self-deployed Worker never calls configureChrome, so the defaults describe it.
let setupNav: NavLink[] = [
  { path: "/settings", label: "Sources", icon: "sources" },
  { path: "/panel/deployment", label: "Deployment", icon: "server" },
];
let brandHref = "/panel";
let instanceLabel = "Self-hosted";
let footNote = "Runs on your Cloudflare account";

export function configureChrome(options: { setupNav?: NavLink[]; brandHref?: string; instanceLabel?: string; footNote?: string }): void {
  if (options.setupNav) setupNav = options.setupNav;
  brandHref = options.brandHref ?? "/panel";
  instanceLabel = options.instanceLabel ?? "Self-hosted";
  footNote = options.footNote ?? footNote;
}

export interface PageOptions {
  title: string;
  active: string;
  heading: string;
  subtitle: string;
  body: string;
  // Pages with side-by-side cards (the panel, /settings) take the full content column; a
  // read-through page keeps a narrower measure.
  wide?: boolean;
  // "app" (default): sidebar and page head. "bare": a single centred column with only the mark,
  // for the OAuth consent pop-up. "door": the hosted sign-in, a night panel beside the form.
  layout?: "app" | "bare" | "door";
  // Extra controls on the right of the page head (app layout only).
  actions?: string;
}

const CSS = `
/* Tokens follow HeroUI v3's default theme (heroui.com): a grey canvas, white surfaces that float
   on a three-layer hairline shadow instead of borders, pill controls, soft tinted chips, one blue
   accent. Dark mode drops the shadows and lifts surfaces by tone alone, as HeroUI does. */
:root{color-scheme:light;
--bg:#f5f5f5;--surface:#ffffff;--surface-2:#efeff0;--surface-3:#eaeaeb;--default:#ebebec;--default-hover:#e2e2e4;
--fg:#18181b;--fg-2:#3f3f46;--muted:#71717a;--faint:#a1a1aa;--border:#dedee0;--separator:#e4e4e7;
--accent:#0485f7;--accent-fg:#ffffff;--accent-soft:color-mix(in oklab,#0485f7 12%,#fff);--accent-text:#0369c9;
--success:#17c964;--success-soft:color-mix(in oklab,#17c964 16%,#fff);--success-text:#12804a;
--warning:#f5a524;--warning-soft:color-mix(in oklab,#f5a524 18%,#fff);--warning-text:#a5650a;
--danger:#ff383c;--danger-soft:color-mix(in oklab,#ff383c 12%,#fff);--danger-text:#d4242a;
--shadow:0 2px 4px rgb(0 0 0/.04),0 1px 2px rgb(0 0 0/.06),0 0 1px rgb(0 0 0/.06);
--shadow-lg:0 8px 24px -6px rgb(0 0 0/.10),0 2px 4px rgb(0 0 0/.04),0 0 1px rgb(0 0 0/.08);
--chip:#ffffff;--night:#060607;
/* names older page styles still use */
--paper:var(--bg);--paper-2:var(--surface-2);--ink:var(--fg);--ink-2:var(--muted);--ink-3:var(--faint);--rule:var(--separator);--rule-2:var(--separator);
--card:var(--surface);--muted-text:var(--muted);--track:var(--default);--ok:var(--success-text);--bad:var(--danger-text);--sel:var(--default);--lift:var(--shadow);--lift-2:var(--shadow-lg);
--btn-bg:var(--fg);--btn-ink:#fff;--btn-hover:#27272a;--outline-bg:var(--default);--outline-hover:var(--default-hover)}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;
--bg:#060607;--surface:#18181b;--surface-2:#232325;--surface-3:#262728;--default:#27272a;--default-hover:#323236;
--fg:#fafafa;--fg-2:#d4d4d8;--muted:#9f9fa9;--faint:#71717a;--border:#28282c;--separator:#26262a;
--accent:#0485f7;--accent-soft:color-mix(in oklab,#0485f7 22%,#18181b);--accent-text:#5eb1ff;
--success-soft:color-mix(in oklab,#17c964 20%,#18181b);--success-text:#45d483;
--warning-soft:color-mix(in oklab,#f5a524 20%,#18181b);--warning-text:#f7b750;
--danger-soft:color-mix(in oklab,#ff383c 20%,#18181b);--danger-text:#ff6b6e;
--shadow:0 0 0 1px rgb(255 255 255/.03);--shadow-lg:0 0 0 1px rgb(255 255 255/.06),0 12px 32px rgb(0 0 0/.5);--chip:#232325;--night:#000;
--btn-bg:#fafafa;--btn-ink:#18181b;--btn-hover:#e4e4e7}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;background:var(--bg)}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue","Noto Sans",Arial,sans-serif;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}
a{color:inherit;text-decoration:none;touch-action:manipulation}
h1,h2,h3{text-wrap:balance}
p,li{text-wrap:pretty}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:8px}
.i{width:18px;height:18px;flex:none}
code,pre,kbd,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace}
.tabular,.num{font-variant-numeric:tabular-nums}
.muted{color:var(--muted)}
.small{font-size:12.5px}
.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.truncate{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* --- shell --------------------------------------------------------------------------- */
.shell{display:grid;grid-template-columns:240px minmax(0,1fr);min-height:100vh;min-height:100dvh}
.side{position:sticky;top:0;height:100vh;height:100dvh;display:flex;flex-direction:column;gap:12px;padding:12px;box-shadow:inset -1px 0 0 rgb(0 0 0/.08);overflow-y:auto;scrollbar-width:none}
@media (prefers-color-scheme:dark){.side{box-shadow:inset -1px 0 0 rgb(255 255 255/.06)}}
.brand{display:flex;align-items:center;gap:10px;padding:6px 8px;border-radius:12px}
.brand-mark{display:grid;place-items:center;width:32px;height:32px;border-radius:10px;background:var(--fg);color:var(--bg);flex:none}
.brand-mark .i{width:18px;height:18px}
.brand-text{display:flex;flex-direction:column;min-width:0;line-height:1.25}
.brand-name{font-weight:600;font-size:14px}
.brand-sub{font-size:12px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.side-search{display:flex;align-items:center;gap:8px;height:36px;padding:0 10px;border-radius:12px;background:var(--surface);box-shadow:var(--shadow)}
.side-search .i{width:16px;height:16px;color:var(--muted)}
.side-search input[type=search]{flex:1;min-width:0;border:0;background:none;box-shadow:none;font:inherit;font-size:14px;color:var(--fg);outline:none;height:100%;padding:0}
.side-search input::placeholder{color:var(--muted)}
.side-search input::-webkit-search-cancel-button{display:none}
.nav{display:flex;flex-direction:column;gap:2px}
.nav-group{margin:14px 8px 4px;font-size:12px;font-weight:500;color:var(--muted)}
.nav-group:first-child{margin-top:4px}
.nav a{display:flex;align-items:center;gap:10px;height:36px;padding:0 8px;border-radius:12px;color:var(--fg);font-size:14px;transition:background-color .15s cubic-bezier(.4,0,.2,1)}
.nav a .i{color:var(--muted)}
.nav a:hover{background:color-mix(in oklab,var(--default) 70%,transparent)}
.nav a[aria-current=page]{background:var(--default);font-weight:500}
.nav a[aria-current=page] .i{color:var(--fg)}
.side-foot{margin-top:auto;display:flex;flex-direction:column;gap:2px}
.side-foot a{display:flex;align-items:center;gap:10px;height:36px;padding:0 8px;border-radius:12px;font-size:14px}
.side-foot a .i{color:var(--muted)}
.side-foot a:hover{background:color-mix(in oklab,var(--default) 70%,transparent)}
.side-foot .ext{margin-left:auto;width:14px;height:14px}
.search-m{display:none}
.main{min-width:0;padding:16px 24px 48px}
.main>.inner{max-width:880px;margin:0 auto}
.main.wide>.inner{max-width:1320px}
.page-head{display:flex;align-items:center;justify-content:space-between;gap:12px 20px;flex-wrap:wrap;min-height:44px;margin:0 0 20px}
h1{margin:0;font-size:20px;line-height:28px;font-weight:600;letter-spacing:-.01em}
.sub{margin:2px 0 0;color:var(--muted);font-size:14px;max-width:72ch}
.page-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.foot{margin-top:40px;display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;color:var(--muted);font-size:12.5px}
.foot a:hover{color:var(--fg)}
@media (max-width:900px){
  .shell{display:block}
  .side{position:sticky;z-index:20;height:auto;flex-direction:row;align-items:center;gap:6px;padding:8px 10px;box-shadow:inset 0 -1px 0 rgb(0 0 0/.08);background:color-mix(in srgb,var(--bg) 88%,transparent);-webkit-backdrop-filter:blur(16px) saturate(1.6);backdrop-filter:blur(16px) saturate(1.6)}
  .brand{padding:0}.brand-text{display:none}.brand-mark{width:30px;height:30px}
  .nav{flex-direction:row;overflow-x:auto;scrollbar-width:none;flex:1;mask-image:linear-gradient(90deg,#000 88%,transparent)}
  .nav::-webkit-scrollbar{display:none}
  .nav a{height:32px;padding:0 10px;white-space:nowrap;gap:6px}
  .nav a .i{width:16px;height:16px}
  .nav-group,.side-foot,.side-search{display:none}
  .search-m{display:grid;place-items:center;flex:none;width:32px;height:32px;border-radius:999px;background:var(--default)}
  .search-m .i{width:16px;height:16px}
  .main{padding:16px 14px 40px}
}

/* --- bare and door ------------------------------------------------------------------- */
.bare{width:min(460px,calc(100% - 32px));margin:0 auto;padding:56px 0 72px}
.bare>.brand{margin:0 0 24px -8px}
.bare .sub{margin-bottom:24px}
.door{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,1fr);min-height:100vh;min-height:100dvh}
.door-night{position:relative;overflow:hidden;background:#030304;color:#fff;display:flex;flex-direction:column;justify-content:flex-end;min-height:100vh;min-height:100dvh;isolation:isolate}
.door-night canvas{position:absolute;inset:0;width:100%;height:100%;opacity:0;transition:opacity 1.4s cubic-bezier(.32,.72,0,1);cursor:grab;touch-action:pan-y;z-index:-2}
.door-night canvas:active{cursor:grabbing}
.door-night.is-live canvas{opacity:1}
.horn-fallback{position:absolute;inset:0 0 60px 0;display:grid;place-items:center;transition:opacity .9s ease-out;z-index:-1;pointer-events:none}
.door-night.is-live .horn-fallback{opacity:0}
.horn-mark{width:min(52%,300px);height:auto;overflow:visible}
.horn-mark .draw{stroke-dasharray:1;stroke-dashoffset:1;animation:horn-draw 2.4s cubic-bezier(.23,1,.32,1) .15s forwards}
@keyframes horn-draw{to{stroke-dashoffset:0}}
.door-foot{display:flex;justify-content:space-between;align-items:center;gap:8px 20px;flex-wrap:wrap;padding:18px clamp(24px,4vw,40px) 22px;color:rgb(255 255 255/.42);font-size:12.5px}
.door-foot a{color:rgb(255 255 255/.62);display:inline-flex;align-items:center;gap:3px;transition:color .15s ease-out}
.door-foot a:hover{color:#fff}
.door-foot .i{width:13px;height:13px}
.door-links{display:inline-flex;gap:16px}
.door-form{display:flex;flex-direction:column;justify-content:center;padding:48px clamp(20px,5vw,72px)}
.door-form>.inner{width:100%;max-width:380px;margin:0 auto}
.door-form h1{font-size:24px;line-height:32px}
.door-form .sub{margin-bottom:24px}
@media (max-width:900px){.door{display:block}.door-night{min-height:min(52vh,460px)}}

/* --- buttons ------------------------------------------------------------------------- */
button,.button{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:36px;padding:0 16px;border:0;border-radius:999px;background:var(--accent);color:var(--accent-fg);font:inherit;font-size:14px;font-weight:500;white-space:nowrap;cursor:pointer;user-select:none;touch-action:manipulation;transition:background-color .15s cubic-bezier(.4,0,.2,1),transform .1s ease-out,opacity .15s}
button:hover,.button:hover{background:color-mix(in oklab,var(--accent) 90%,#fff 10%)}
button:active,.button:active{transform:scale(.97)}
button .i,.button .i{width:16px;height:16px}
button.secondary,.button.secondary,.button.ghost,button.ghost{background:var(--default);color:var(--fg)}
button.secondary:hover,.button.secondary:hover,.button.ghost:hover,button.ghost:hover{background:var(--default-hover)}
button.danger,.button.ghost.danger,.button.danger{background:var(--danger-soft);color:var(--danger-text)}
button.danger:hover,.button.ghost.danger:hover{background:color-mix(in oklab,var(--danger) 20%,var(--surface))}
button.sm,.button.sm{height:32px;padding:0 12px;font-size:13.5px}
button.xs,.button.xs{height:28px;padding:0 10px;font-size:12.5px}
button.lg,.button.lg{height:44px;padding:0 20px;font-size:15px}
.icon-btn{width:32px;height:32px;padding:0;border-radius:999px;background:var(--default);color:var(--fg);display:inline-grid;place-items:center}
.button.night{background:#fff;color:#030304}
.button.night-outline{background:rgb(255 255 255/.08);color:#fff}
.link{color:var(--accent-text)}
.link:hover{text-decoration:underline;text-underline-offset:3px}
.more{display:inline-flex;align-items:center;gap:4px;color:var(--muted);font-size:13px;font-weight:500;white-space:nowrap;height:28px;padding:0 10px;border-radius:999px;transition:background-color .15s,color .15s}
.more .i{width:14px;height:14px}
.more:hover{color:var(--fg);background:var(--default)}

/* --- surfaces -------------------------------------------------------------------------- */
.card{background:var(--surface);border-radius:16px;box-shadow:var(--shadow);margin-bottom:16px;min-width:0}
.card-head{padding:16px 16px 0}
.card-head.row{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:48px;padding-top:12px}
.card-title{display:flex;align-items:center;gap:10px;min-width:0}
.card-title>.i{display:none}
h2{margin:0;font-size:16px;line-height:24px;font-weight:500}
h3{margin:0;font-size:14px;font-weight:600}
.card-sub{margin:2px 0 0;color:var(--muted);font-size:13px}
.card-body{padding:12px 16px 16px}
.card-body a:not(.button):not(.more):not(.plain):not(.badge):not([aria-current]):not(.icon-btn),.card-sub a,.notice a,.steps a,.hint a{color:var(--accent-text)}
.card-body a:not(.button):not(.more):not(.plain):not(.badge):not([aria-current]):not(.icon-btn):hover,.card-sub a:hover{text-decoration:underline;text-underline-offset:3px}
.section-label{margin:28px 0 10px;display:flex;align-items:center;justify-content:space-between;gap:12px}
.section-label h2{font-size:16px;font-weight:600}
.section-label .count{color:var(--muted);font-weight:500;margin-left:6px;font-size:13px}
.rows>*{border-top:1px solid var(--separator)}
.rows>:first-child{border-top:0}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(360px,100%),1fr));gap:16px;align-items:start}
.grid2>.card{margin-bottom:0}
.split{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(0,1fr);gap:16px;align-items:start;margin-bottom:16px}
.split.even{align-items:stretch}
.split.even>.card{height:100%;display:flex;flex-direction:column}
.split.even>.card>.card-body{flex:1;display:flex;flex-direction:column}
.split>.col{display:flex;flex-direction:column;gap:16px;min-width:0}
.split .card{margin-bottom:0}
@media (max-width:1100px){.split{grid-template-columns:minmax(0,1fr)}}
.stack{display:flex;flex-direction:column;gap:16px}

/* --- KPI cards ------------------------------------------------------------------------ */
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(190px,100%),1fr));gap:16px;margin-bottom:16px}
@media (max-width:640px){.stats{grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.stat{padding:14px}.stat-value{font-size:22px}}
.stat{display:block;background:var(--surface);border-radius:16px;box-shadow:var(--shadow);padding:16px;min-width:0;transition:box-shadow .15s}
a.stat:hover{box-shadow:var(--shadow-lg)}
.stat-label{display:flex;align-items:center;gap:8px;color:var(--muted);font-size:14px;font-weight:500}
.stat-label .i{display:none}
.stat-value{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:8px;font-size:24px;line-height:32px;font-weight:600;letter-spacing:-.6px;font-variant-numeric:tabular-nums}
.stat-hint{margin-top:2px;color:var(--muted);font-size:12.5px;display:flex;align-items:center;gap:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

/* --- chips, marks, states -------------------------------------------------------------- */
.badge,.chip{display:inline-flex;align-items:center;gap:4px;height:22px;padding:0 8px;border-radius:999px;font-size:12px;font-weight:500;line-height:1;white-space:nowrap;background:var(--default);color:var(--fg-2);vertical-align:middle;border:0}
.badge .i,.chip .i{width:12px;height:12px}
.badge.ok,.chip.success{background:var(--success-soft);color:var(--success-text)}
.badge.error,.chip.danger{background:var(--danger-soft);color:var(--danger-text)}
.chip.warning{background:var(--warning-soft);color:var(--warning-text)}
.chip.accent,.badge.tool{background:var(--accent-soft);color:var(--accent-text)}
.badge.course{background:var(--default);color:var(--fg);font-weight:600;font-variant-numeric:tabular-nums;letter-spacing:.01em}
a.badge.course:hover{background:var(--default-hover)}
.trend{display:inline-flex;align-items:center;gap:2px;height:20px;padding:0 6px;border-radius:999px;font-size:12px;font-weight:500;letter-spacing:0}
.trend.up{background:var(--success-soft);color:var(--success-text)}
.trend.down{background:var(--danger-soft);color:var(--danger-text)}
.trend.flat{background:var(--default);color:var(--muted)}
.tile-mark{display:inline-grid;place-items:center;flex:none;width:32px;height:32px;border-radius:999px;background:var(--surface-2);color:var(--fg)}
.tile-mark svg{width:16px;height:16px}
.tile-mark.sm{width:24px;height:24px}
.tile-mark.sm svg{width:13px;height:13px}
.tile-mark.lg{width:44px;height:44px}
.tile-mark.lg svg{width:22px;height:22px}
.tile-mark.client{background:var(--surface);box-shadow:var(--shadow)}
.tile-mark.mono{background:var(--default);color:var(--muted);font-size:12px;font-weight:600}
.tile-mark.sm.mono{font-size:10.5px}
.tile-mark.src{background:color-mix(in oklab,var(--hue) 18%,var(--surface));color:color-mix(in oklab,var(--hue) 55%,var(--fg))}
.src-dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--hue);flex:none}
.who{display:inline-flex;align-items:center;gap:10px;min-width:0;vertical-align:middle}
.who-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.state{display:inline-flex;align-items:center;gap:6px;height:22px;padding:0 8px 0 7px;border-radius:999px;font-size:12px;font-weight:500;white-space:nowrap;background:var(--success-soft);color:var(--success-text)}
.state::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}
.state.bad{background:var(--danger-soft);color:var(--danger-text)}
.state.off{background:var(--default);color:var(--muted)}
.state.warn{background:var(--warning-soft);color:var(--warning-text)}
.empty{display:flex;flex-direction:column;align-items:center;text-align:center;gap:8px;padding:28px 12px;color:var(--muted);font-size:13.5px}
.empty .i{width:22px;height:22px;color:var(--faint)}
.empty p{margin:0;max-width:40ch}

/* --- lists ----------------------------------------------------------------------------- */
.list{list-style:none;margin:0;padding:0}
.list>li{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 0;border-top:1px solid var(--separator);font-size:14px;min-width:0}
.list>li:first-child{border-top:0;padding-top:4px}
.list .grow{flex:1;min-width:0}
.list .end{flex:none;color:var(--muted);font-size:12.5px;text-align:right;font-variant-numeric:tabular-nums}

/* --- tables: grey wrapper, white rows, as HeroUI's data grid --------------------------- */
.table-wrap{background:var(--surface-2);border-radius:20px;padding:0 4px 4px;overflow-x:auto}
table{width:100%;border-collapse:separate;border-spacing:0;font-size:14px}
th{text-align:left;font-weight:500;color:var(--muted);font-size:12px;line-height:16px;padding:10px 16px;white-space:nowrap}
td{padding:12px 16px;background:var(--surface);border-bottom:1px solid var(--separator);vertical-align:middle}
tbody tr:last-child td{border-bottom:0}
tbody tr:first-child td:first-child{border-top-left-radius:16px}
tbody tr:first-child td:last-child{border-top-right-radius:16px}
tbody tr:last-child td:first-child{border-bottom-left-radius:16px}
tbody tr:last-child td:last-child{border-bottom-right-radius:16px}
tbody tr:hover td{background:color-mix(in oklab,var(--surface) 96%,var(--fg) 4%)}
td.num,th.num{text-align:right;white-space:nowrap}
td.num{color:var(--muted)}
td.when{color:var(--muted);white-space:nowrap;font-variant-numeric:tabular-nums}
td code,.tool{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;background:none;border:0;padding:0;color:var(--fg)}
.card .table-wrap{margin:0 -12px -12px;border-radius:0 0 16px 16px}
.what{display:inline-flex;align-items:center;gap:10px}
details summary{cursor:pointer;color:var(--muted);font-size:13px;list-style:none;display:flex;align-items:center;gap:6px;max-width:44ch}
details summary::-webkit-details-marker{display:none}
details summary::before{content:"";flex:none;width:5px;height:5px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;rotate:-45deg;transition:rotate .15s ease-out}
details[open] summary::before{rotate:45deg}
details summary span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* --- code, commands, fields ------------------------------------------------------------ */
code{font-size:12.5px;background:var(--default);border-radius:6px;padding:1px 6px}
pre{font-size:12.5px;line-height:1.6;background:var(--surface-2);border-radius:12px;padding:12px 14px;overflow-x:auto;white-space:pre-wrap;word-break:break-word;margin:8px 0 0}
pre.night{background:#18181b;color:#fafafa;white-space:pre}
.cmd{display:flex;align-items:center;gap:8px;background:var(--surface-2);color:var(--fg);border-radius:12px;padding:4px 4px 4px 14px;margin:8px 0;min-width:0}
.cmd code{flex:1;min-width:0;background:none;padding:6px 0;color:inherit;font-size:12.5px;white-space:nowrap;overflow-x:auto;scrollbar-width:none}
.cmd code::-webkit-scrollbar{display:none}
.cmd .prompt{color:var(--muted);user-select:none}
.cmd button{height:30px;padding:0 12px;font-size:12.5px;background:var(--surface);color:var(--fg);box-shadow:var(--shadow)}
.cmd button:hover{background:var(--surface)}
.cmd button .i{width:14px;height:14px}
.cmd.hero{background:#18181b;color:#fafafa;padding:6px 6px 6px 16px}
.cmd.hero code{font-size:14px}
.cmd.hero button{background:rgb(255 255 255/.1);color:#fff;box-shadow:none}
textarea{width:100%;min-height:150px;font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--surface);color:var(--fg);border:0;border-radius:12px;box-shadow:var(--shadow);padding:10px 12px;resize:vertical;transition:box-shadow .15s}
.card textarea,.card input[type=text],.card input[type=email],.card input[type=password],.card input[type=number],.card select{background:var(--surface-2);box-shadow:none}
input[type=text],input[type=email],input[type=password],input[type=number],input[type=search],select{width:100%;height:36px;font:inherit;font-size:14px;background:var(--surface);color:var(--fg);border:0;border-radius:12px;box-shadow:var(--shadow);padding:0 12px;transition:box-shadow .15s}
textarea:focus,input:focus,select:focus{outline:none;box-shadow:0 0 0 2px var(--accent)}
::placeholder{color:var(--muted)}
label.field{display:block;font-size:14px;font-weight:500;margin:14px 0 6px}
.notice{display:flex;align-items:center;gap:10px;margin:0 0 16px;padding:10px 14px;border-radius:12px;background:var(--success-soft);color:var(--success-text);font-size:13.5px;font-weight:500}
.notice.error{background:var(--danger-soft);color:var(--danger-text)}
div.notice{display:block;font-weight:400}
.meter,.progress{height:6px;background:var(--default);border-radius:999px;overflow:hidden}
.meter>span,.progress>span{display:block;height:100%;background:var(--accent);border-radius:999px}
.meter.warn>span{background:var(--warning)}

/* --- settings: label left, control right, separators between (HeroUI's settings page) --- */
.settings{display:flex;flex-direction:column}
.setting{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.25fr);gap:16px 48px;padding:24px 0;border-top:1px solid var(--separator)}
.setting:first-child{border-top:0;padding-top:8px}
.setting-text h3{font-size:14px;font-weight:500;margin:0}
.setting-text p{margin:4px 0 0;font-size:13px;color:var(--muted);max-width:52ch}
.setting-control{display:flex;flex-direction:column;align-items:flex-start;gap:8px;min-width:0}
.setting-control>form,.setting-control input,.setting-control textarea,.setting-control select{width:100%}
.setting-control .hint{margin:0;font-size:12.5px;color:var(--muted)}
.setting-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}
@media (max-width:760px){.setting{grid-template-columns:minmax(0,1fr);gap:12px}}

/* --- segmented control ------------------------------------------------------------------ */
.filters{display:inline-flex;gap:2px;flex-wrap:wrap;padding:4px;background:var(--default);border-radius:999px}
.filters a{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 12px;border-radius:999px;font-size:13.5px;font-weight:500;color:var(--muted);transition:background-color .15s,color .15s}
.filters a .i{width:15px;height:15px}
.filters a:hover{color:var(--fg)}
.filters a[aria-current=true]{background:var(--surface);color:var(--fg);box-shadow:var(--shadow)}
@media (prefers-color-scheme:dark){.filters a[aria-current=true]{background:#46464c}}
.toolbar{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:16px}

/* --- steps --------------------------------------------------------------------------- */
.steps{counter-reset:step;list-style:none;margin:0;padding:0}
.steps li{counter-increment:step;position:relative;padding:6px 0 6px 34px;font-size:14px;color:var(--fg-2)}
.steps li::before{content:counter(step);position:absolute;left:0;top:6px;width:22px;height:22px;border-radius:999px;background:var(--default);display:grid;place-items:center;font-size:12px;font-weight:600;color:var(--muted);font-variant-numeric:tabular-nums}
.steps li strong,.steps li em{color:var(--fg)}
.pager{display:flex;justify-content:center;margin-top:14px}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
`;

function renderNav(active: string): string {
  const link = (page: NavLink) =>
    `<a href="${page.path}"${page.path === active ? ' aria-current="page"' : ""}>${page.icon ? icon(page.icon) : ""}<span>${page.label}</span></a>`;
  const groups = [...NAV_GROUPS, { label: "Setup", links: setupNav }];
  return groups.map((group) => `<p class="nav-group">${group.label}</p>${group.links.map(link).join("")}`).join("");
}

function brand(href: string, withInstance = false): string {
  return `<a class="brand" href="${href}" translate="no"><span class="brand-mark">${icon("horn")}</span><span class="brand-text"><span class="brand-name">unicorn</span>${withInstance ? `<span class="brand-sub">${instanceLabel}</span>` : ""}</span></a>`;
}

const ext = icon("external", "i ext");

function head(title: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="#f5f5f5" media="(prefers-color-scheme: light)">
  <meta name="theme-color" content="#060607" media="(prefers-color-scheme: dark)">
  <meta name="robots" content="noindex">
  <title>${title}</title>
  <style>${CSS}</style>
</head>`;
}

export function renderPage(options: PageOptions): string {
  const layout = options.layout ?? "app";
  if (layout === "bare") {
    return `${head(options.title)}
<body>
  <main class="bare">
    ${brand("/")}
    <h1>${options.heading}</h1>
    <p class="sub">${options.subtitle}</p>
    ${options.body}
  </main>
</body>
</html>`;
  }
  if (layout === "door") {
    return `${head(options.title)}
<body>
  <div class="door">
    <section class="door-night" data-horn aria-label="About unicorn">
      <canvas aria-hidden="true"></canvas>
      <div class="horn-fallback">${HORN_FALLBACK}</div>
      <div class="door-foot">
        <span>${options.actions ?? ""}</span>
        <span class="door-links"><a href="${SITE}" target="_blank" rel="noopener">How it works${icon("external")}</a><a href="${DOCS}" target="_blank" rel="noopener">Docs${icon("external")}</a></span>
      </div>
    </section>
    <main class="door-form"><div class="inner">
      <h1>${options.heading}</h1>
      <p class="sub">${options.subtitle}</p>
      ${options.body}
    </div></main>
  </div>
  ${HORN_SCRIPT}
</body>
</html>`;
  }
  return `${head(options.title)}
<body>
  <div class="shell">
    <aside class="side">
      ${brand(brandHref, true)}
      <form class="side-search" method="get" action="/panel/search" role="search">${icon("search")}<input type="search" name="q" placeholder="Search everything" aria-label="Search everything"></form>
      <nav class="nav" aria-label="Dashboard">${renderNav(options.active)}</nav>
      <a class="search-m" href="/panel/search" aria-label="Search">${icon("search")}</a>
      <div class="side-foot">
        <a href="${DOCS}" target="_blank" rel="noopener">${icon("docs")}Docs${ext}</a>
        <a href="${SITE}" target="_blank" rel="noopener">${icon("horn")}unicorn.tuuhub.com${ext}</a>
      </div>
    </aside>
    <main class="main${options.wide ? " wide" : ""}"><div class="inner">
      <header class="page-head">
        <div><h1>${options.heading}</h1><p class="sub">${options.subtitle}</p></div>
        ${options.actions ? `<div class="page-actions">${options.actions}</div>` : ""}
      </header>
      ${options.body}
      <footer class="foot"><span>${footNote}</span><span><a href="${DOCS}" target="_blank" rel="noopener">Docs</a> · <a href="https://github.com/TuuHub/unicorn" target="_blank" rel="noopener">GitHub</a></span></footer>
    </div></main>
  </div>
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
