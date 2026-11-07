// Shared shell for every rendered page: the panel (ADR-0048), /settings, the OAuth consent page
// and the hosted server's sign-in. Plain HTML+CSS strings by design (ADR-0026): zero framework,
// zero client state, nothing loaded from anywhere else.
//
// The look is unicorn.tuuhub.com's paper half: warm paper, one ink, hairline rules, square-
// shouldered buttons, line glyphs in a 1.5 stroke, and the spectrum only where it means a source.
// The dark scheme is the landing page's night. Token names match unicorn-site's globals.css.

import { icon } from "./marks";

interface NavLink {
  path: string;
  label: string;
  icon?: Parameters<typeof icon>[0];
}

const NAV: NavLink[] = [
  { path: "/panel", label: "Overview", icon: "overview" },
  { path: "/panel/activity", label: "Activity", icon: "activity" },
  { path: "/panel/memory", label: "Memory", icon: "memory" },
  { path: "/panel/connect", label: "Connect", icon: "connect" },
  { path: "/settings", label: "Sources", icon: "sources" },
];

const SITE = "https://unicorn.tuuhub.com";
const DOCS = `${SITE}/docs/unicorn`;

// The hosted server (ADR-0046) adds its account links once at startup; a self-deployed Worker
// never calls this. Module-level on purpose: one process serves one deployment mode.
let extraNav: NavLink[] = [];
let brandHref = "/panel";
let instanceLabel = "Self-hosted";

export function configureChrome(options: { extraNav?: NavLink[]; brandHref?: string; instanceLabel?: string }): void {
  extraNav = (options.extraNav ?? []).map((link) => ({ icon: "account", ...link }));
  brandHref = options.brandHref ?? "/panel";
  instanceLabel = options.instanceLabel ?? "Self-hosted";
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
:root{color-scheme:light;
--paper:#f5f4ef;--paper-2:#ecebe4;--surface:#fcfbf8;--ink:#121212;--ink-2:#55534d;--ink-3:#7c7a73;--rule:#dddbd2;--rule-2:#e7e5dd;--night:#030304;--track:#d8d6cd;
--ok:#2f9b5a;--warn:#c27c0e;--bad:#d23f36;--sel:rgb(18 18 18/.05);--lift:0 1px 2px rgb(18 18 18/.05);--lift-2:0 1px 2px rgb(18 18 18/.04),0 12px 32px -18px rgb(30 28 20/.28);
--btn-bg:#121212;--btn-ink:#f5f4ef;--btn-hover:#2b2b29;--btn-shadow:inset 0 1px 0 rgb(255 255 255/.14),0 1px 2px rgb(18 18 18/.2);
--outline-bg:rgb(255 255 255/.7);--outline-hover:#fff;--chip:#fff;
--bg:var(--paper);--card:var(--surface);--border:var(--rule);--muted:var(--ink-2);--accent:var(--ink)}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;
--paper:#0b0b0c;--paper-2:#141415;--surface:#111112;--ink:#f3f2ec;--ink-2:#aaa8a0;--ink-3:#7d7b74;--rule:#27272a;--rule-2:#1f1f21;--night:#000;--track:#2e2e31;
--ok:#4cc27e;--warn:#e8a33a;--bad:#ff6b61;--sel:rgb(255 255 255/.06);--lift:0 1px 2px rgb(0 0 0/.4);--lift-2:0 1px 2px rgb(0 0 0/.4),0 16px 40px -20px rgb(0 0 0/.8);
--btn-bg:#f3f2ec;--btn-ink:#0b0b0c;--btn-hover:#dcdbd5;--btn-shadow:inset 0 -1px 0 rgb(0 0 0/.14);
--outline-bg:rgb(255 255 255/.03);--outline-hover:rgb(255 255 255/.08);--chip:#19191b}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;background:var(--paper)}
body{margin:0;background:var(--paper);color:var(--ink);font:14.5px/1.6 "Geist","Inter",ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;text-rendering:optimizeLegibility}
::selection{background:var(--ink);color:var(--paper)}
a{color:inherit;text-decoration:none;touch-action:manipulation}
h1,h2,h3{text-wrap:balance}
p,li{text-wrap:pretty}
:focus-visible{outline:2px solid currentColor;outline-offset:3px;border-radius:6px}
.i{width:18px;height:18px;flex:none}
.mono,code,pre,kbd,textarea.mono{font-family:"Geist Mono",ui-monospace,SFMono-Regular,Menlo,monospace}
.tabular,.num{font-variant-numeric:tabular-nums}
.muted{color:var(--ink-3)}
.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}

/* --- shell --------------------------------------------------------------------------- */
.shell{display:grid;grid-template-columns:244px minmax(0,1fr);min-height:100vh;min-height:100dvh}
.side{position:sticky;top:0;height:100vh;height:100dvh;display:flex;flex-direction:column;gap:20px;padding:20px 14px;border-right:1px solid var(--rule)}
.brand{display:inline-flex;align-items:center;gap:9px;padding:4px 8px;font-weight:600;font-size:15.5px;letter-spacing:-.015em}
.brand .i{width:20px;height:20px}
.instance{margin-left:auto;font-size:11px;font-weight:500;color:var(--ink-3);border:1px solid var(--rule);border-radius:6px;padding:0 6px;line-height:18px}
.nav{display:flex;flex-direction:column;gap:2px}
.nav a{display:flex;align-items:center;gap:10px;height:36px;padding:0 10px;border-radius:8px;border:1px solid transparent;color:var(--ink-2);font-size:14px;font-weight:500;transition:background-color .15s ease-out,color .15s ease-out}
.nav a .i{color:var(--ink-3);transition:color .15s ease-out}
.nav a:hover{background:var(--sel);color:var(--ink)}
.nav a[aria-current=page]{background:var(--surface);border-color:var(--rule);color:var(--ink);box-shadow:var(--lift)}
.nav a[aria-current=page] .i,.nav a:hover .i{color:var(--ink)}
.nav-sep{height:1px;background:var(--rule);margin:8px 10px}
.side-foot{margin-top:auto;display:flex;flex-direction:column;gap:2px;padding-top:14px;border-top:1px solid var(--rule)}
.side-foot a{display:flex;align-items:center;gap:10px;height:32px;padding:0 10px;border-radius:8px;color:var(--ink-3);font-size:13px}
.side-foot a:hover{color:var(--ink);background:var(--sel)}
.side-foot .i{width:16px;height:16px}
.side-foot .ext{margin-left:auto;width:14px;height:14px;opacity:.6}
.main{min-width:0;padding:40px clamp(20px,4vw,56px) 72px}
.main>.inner{max-width:760px;margin:0 auto}
.main.wide>.inner{max-width:1160px}
.page-head{display:flex;align-items:flex-end;justify-content:space-between;gap:16px 24px;flex-wrap:wrap;margin-bottom:28px}
h1{margin:0;font-size:clamp(26px,3.2vw,32px);line-height:1.1;font-weight:600;letter-spacing:-.035em}
.sub{margin:8px 0 0;color:var(--ink-2);font-size:15px;max-width:62ch}
.page-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.foot{margin-top:56px;padding-top:20px;border-top:1px solid var(--rule);display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;color:var(--ink-3);font-size:12.5px}
.foot a{text-decoration:underline;text-decoration-color:var(--rule);text-underline-offset:2px}
.foot a:hover{color:var(--ink-2)}
@media (max-width:900px){
  .shell{display:block}
  .side{position:sticky;z-index:20;height:auto;flex-direction:row;align-items:center;gap:8px;padding:10px 12px;border-right:0;border-bottom:1px solid var(--rule);background:color-mix(in srgb,var(--paper) 86%,transparent);-webkit-backdrop-filter:blur(16px) saturate(1.5);backdrop-filter:blur(16px) saturate(1.5)}
  .side .brand span:not(.instance),.side .instance{display:none}
  .stats .stat:last-child:nth-child(odd){grid-column:1/-1}
  .nav{flex-direction:row;overflow-x:auto;scrollbar-width:none;flex:1;mask-image:linear-gradient(90deg,#000 88%,transparent)}
  .nav::-webkit-scrollbar{display:none}
  .nav a{height:32px;padding:0 10px;font-size:13.5px;white-space:nowrap;gap:7px}
  .nav a .i{width:16px;height:16px}
  .nav-sep,.side-foot{display:none}
  .main{padding:28px 16px 56px}
}

/* --- bare and door ------------------------------------------------------------------- */
.bare{width:min(480px,calc(100% - 32px));margin:0 auto;padding:56px 0 72px}
.bare .brand{margin:0 0 28px -8px}
.bare h1{font-size:26px}
.bare .sub{margin-bottom:24px}
.door{display:grid;grid-template-columns:minmax(0,1.05fr) minmax(0,1fr);min-height:100vh;min-height:100dvh}
.door-night{position:relative;overflow:hidden;background:var(--night);color:#fff;padding:28px clamp(24px,5vw,64px);display:flex;flex-direction:column;justify-content:space-between;gap:40px}
.door-night::before{content:"";position:absolute;inset:auto -20% -30% -20%;height:70%;background:radial-gradient(50% 50% at 30% 60%,rgb(255 120 160/.18),transparent 70%),radial-gradient(40% 40% at 65% 45%,rgb(110 190 255/.16),transparent 70%),radial-gradient(35% 35% at 50% 75%,rgb(140 230 160/.10),transparent 70%);filter:blur(10px);pointer-events:none}
.door-night>*{position:relative}
.door-night .brand{margin-left:-8px;color:#fff}
.door-title{margin:0;font-size:clamp(44px,6.4vw,88px);line-height:.92;font-weight:600;letter-spacing:-.045em;max-width:9ch}
.door-lede{margin:22px 0 0;max-width:34rem;color:rgb(255 255 255/.7);font-size:16.5px;line-height:1.6}
.door-links{display:flex;gap:10px;flex-wrap:wrap;margin-top:28px}
.door-meta{color:rgb(255 255 255/.45);font-size:12.5px;display:flex;gap:16px;flex-wrap:wrap}
.door-meta a{color:rgb(255 255 255/.7)}
.door-form{display:flex;flex-direction:column;justify-content:center;padding:48px clamp(20px,5vw,72px)}
.door-form>.inner{width:100%;max-width:400px;margin:0 auto}
.door-form h1{font-size:28px}
.door-form .sub{margin-bottom:24px}
.text-spectrum{background-image:linear-gradient(100deg,#ff7a70 0%,#ffc35c 18%,#8be39a 36%,#6dbbff 54%,#b896ff 72%,#ff7a70 90%);background-size:220% 100%;-webkit-background-clip:text;background-clip:text;color:transparent;animation:spectrum-slide 14s linear infinite}
@keyframes spectrum-slide{to{background-position:-220% 0}}
@media (max-width:900px){.door{display:block}.door-night{min-height:0;gap:28px;padding-bottom:36px}.door-title{font-size:clamp(44px,13vw,64px)}}

/* --- buttons ------------------------------------------------------------------------- */
button,.button{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:34px;padding:0 14px;border:0;border-radius:8px;background:var(--btn-bg);color:var(--btn-ink);box-shadow:var(--btn-shadow);font:inherit;font-size:13.5px;font-weight:500;white-space:nowrap;cursor:pointer;user-select:none;touch-action:manipulation;transition:background-color .15s ease-out,border-color .15s ease-out,color .15s ease-out,scale .15s ease-out}
button:hover,.button:hover{background:var(--btn-hover)}
button:active,.button:active{scale:.98}
button .i,.button .i{width:15px;height:15px}
button.secondary,.button.secondary,.button.ghost,button.ghost{background:var(--outline-bg);color:var(--ink);border:1px solid var(--rule);box-shadow:var(--lift)}
button.secondary:hover,.button.secondary:hover,.button.ghost:hover,button.ghost:hover{background:var(--outline-hover);border-color:color-mix(in srgb,var(--rule) 70%,var(--ink-3))}
.button.ghost.danger,button.danger{color:var(--bad)}
button.lg,.button.lg{height:42px;padding:0 18px;font-size:14.5px}
button.sm,.button.sm{height:28px;padding:0 10px;font-size:12.5px}
.button.night{background:#fff;color:#030304;box-shadow:inset 0 -1px 0 rgb(0 0 0/.14)}
.button.night:hover{background:#e9e9e6}
.button.night-outline{background:rgb(255 255 255/.04);color:#fff;border:1px solid rgb(255 255 255/.15);box-shadow:0 1px 2px rgb(0 0 0/.4)}
.button.night-outline:hover{background:rgb(255 255 255/.09);border-color:rgb(255 255 255/.25)}
.link{color:var(--ink);text-decoration:underline;text-decoration-color:var(--rule);text-decoration-thickness:1px;text-underline-offset:3px;transition:text-decoration-color .15s ease-out}
.link:hover{text-decoration-color:var(--ink-3)}
.more{display:inline-flex;align-items:center;gap:4px;color:var(--ink-2);font-size:13px;font-weight:500;white-space:nowrap}
.more .i{width:14px;height:14px;transition:translate .15s ease-out}
.more:hover{color:var(--ink)}
.more:hover .i{translate:2px 0}

/* --- cards --------------------------------------------------------------------------- */
.card{background:var(--surface);border:1px solid var(--rule);border-radius:14px;box-shadow:var(--lift);margin-bottom:16px;min-width:0}
.card-head{padding:18px 20px 0}
.card-head.row{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.card-title{display:flex;align-items:center;gap:10px}
.card-title .i{color:var(--ink-3);width:17px;height:17px}
h2{margin:0;font-size:15px;font-weight:600;letter-spacing:-.01em}
h3{margin:0;font-size:14.5px;font-weight:600;letter-spacing:-.01em}
.card-sub{margin:3px 0 0;color:var(--ink-2);font-size:13px}
.card-body{padding:12px 20px 20px}
.card-body a:not(.button):not(.more):not(.plain),.card-sub a,.notice a,.steps a,.hint a{color:var(--ink);text-decoration:underline;text-decoration-color:var(--rule);text-decoration-thickness:1px;text-underline-offset:3px}
.card-body a:not(.button):not(.more):not(.plain):hover,.card-sub a:hover{text-decoration-color:var(--ink-3)}
.section-label{margin:36px 0 12px;display:flex;align-items:baseline;justify-content:space-between;gap:12px}
.section-label h2{font-size:16px}
.rows>*{border-top:1px solid var(--rule-2)}
.rows>:first-child{border-top:0}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(340px,100%),1fr));gap:16px;align-items:start}
.grid2>.card{margin-bottom:0}
.split{display:grid;grid-template-columns:minmax(0,1.55fr) minmax(0,1fr);gap:16px;align-items:start}
.split>.col{display:flex;flex-direction:column;gap:16px;min-width:0}
.split .card{margin-bottom:0}
@media (max-width:1100px){.split{grid-template-columns:minmax(0,1fr)}}
.stack{display:flex;flex-direction:column;gap:16px}

/* --- stats --------------------------------------------------------------------------- */
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(176px,100%),1fr));gap:1px;background:var(--rule);border:1px solid var(--rule);border-radius:14px;overflow:hidden;box-shadow:var(--lift);margin-bottom:16px}
.stat{background:var(--surface);padding:16px 18px 15px;min-width:0}
.stat-label{display:flex;align-items:center;gap:7px;color:var(--ink-2);font-size:12.5px;font-weight:500}
.stat-label .i{width:15px;height:15px;color:var(--ink-3)}
.stat-value{margin-top:8px;font-size:30px;line-height:1;font-weight:600;letter-spacing:-.035em;font-variant-numeric:tabular-nums}
.stat-value small{font-size:14px;font-weight:500;letter-spacing:-.01em;color:var(--ink-3);margin-left:3px}
.stat-hint{margin-top:7px;color:var(--ink-3);font-size:12.5px;display:flex;align-items:center;gap:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

/* --- lists, marks, states -------------------------------------------------------------- */
.list{list-style:none;margin:0;padding:0}
.list>li{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:11px 0;border-top:1px solid var(--rule-2);font-size:14px;min-width:0}
.list>li:first-child{border-top:0;padding-top:4px}
.list .grow{flex:1;min-width:0}
.list .end{flex:none;color:var(--ink-3);font-size:12.5px;text-align:right;font-variant-numeric:tabular-nums}
.truncate{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tile-mark{display:inline-grid;place-items:center;flex:none;width:30px;height:30px;border-radius:8px;border:1px solid var(--rule);background:var(--chip);color:var(--ink);box-shadow:0 1px 1px rgb(18 18 18/.04)}
.tile-mark svg{width:17px;height:17px}
.tile-mark.sm{width:22px;height:22px;border-radius:6px}
.tile-mark.sm svg{width:13px;height:13px}
.tile-mark.lg{width:44px;height:44px;border-radius:11px}
.tile-mark.lg svg{width:24px;height:24px}
.tile-mark.mono{background:var(--paper-2);color:var(--ink-2);font-size:12px;font-weight:600}
.tile-mark.sm.mono{font-size:10.5px}
.tile-mark.lg.mono{font-size:17px}
.tile-mark.src{background:color-mix(in srgb,var(--hue) 16%,var(--surface));border-color:color-mix(in srgb,var(--hue) 38%,var(--surface));color:color-mix(in srgb,var(--hue) 30%,var(--ink))}
.src-dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--hue);flex:none}
.who{display:inline-flex;align-items:center;gap:8px;min-width:0;vertical-align:middle}
.who-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.state{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;color:var(--ink-2);white-space:nowrap}
.state::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--ok);box-shadow:0 0 0 3px color-mix(in srgb,var(--ok) 18%,transparent)}
.state.bad{color:var(--bad)}
.state.bad::before{background:var(--bad);box-shadow:0 0 0 3px color-mix(in srgb,var(--bad) 18%,transparent)}
.state.off::before{background:var(--ink-3);box-shadow:0 0 0 3px color-mix(in srgb,var(--ink-3) 18%,transparent)}
.state.warn::before{background:var(--warn);box-shadow:0 0 0 3px color-mix(in srgb,var(--warn) 18%,transparent)}
.badge{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;font-weight:500;line-height:18px;padding:0 7px;border-radius:6px;border:1px solid var(--rule);background:var(--chip);color:var(--ink-2);white-space:nowrap;vertical-align:1px}
.badge.ok{color:var(--ok);border-color:color-mix(in srgb,var(--ok) 35%,var(--rule))}
.badge.error{color:var(--bad);border-color:color-mix(in srgb,var(--bad) 35%,var(--rule));background:color-mix(in srgb,var(--bad) 6%,var(--chip))}
.badge.course{font-family:"Geist Mono",ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--ink);background:var(--paper-2)}
.empty{display:flex;flex-direction:column;align-items:flex-start;gap:6px;padding:8px 0 4px;color:var(--ink-2);font-size:13.5px}
.empty .i{color:var(--ink-3)}
.empty p{margin:0}

/* --- table --------------------------------------------------------------------------- */
.table-wrap{overflow-x:auto;margin:0 -20px;padding:0 20px}
table{width:100%;border-collapse:collapse;font-size:13.5px}
th{text-align:left;font-weight:500;color:var(--ink-3);font-size:12px;padding:0 12px 10px;border-bottom:1px solid var(--rule);white-space:nowrap}
td{padding:11px 12px;border-bottom:1px solid var(--rule-2);vertical-align:middle}
th:first-child,td:first-child{padding-left:0}
th:last-child,td:last-child{padding-right:0}
tbody tr:last-child td{border-bottom:0}
td.num{text-align:right;white-space:nowrap;color:var(--ink-2)}
td.when{color:var(--ink-3);white-space:nowrap;font-variant-numeric:tabular-nums}
td code,.tool{font-family:"Geist Mono",ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;background:none;border:0;padding:0;color:var(--ink)}
.what{display:inline-flex;align-items:center;gap:8px}
details summary{cursor:pointer;color:var(--ink-2);font-size:12.5px;list-style:none;display:flex;align-items:center;gap:6px;max-width:44ch}
details summary::-webkit-details-marker{display:none}
details summary::before{content:"";flex:none;width:5px;height:5px;border-right:1.5px solid var(--ink-3);border-bottom:1.5px solid var(--ink-3);rotate:-45deg;transition:rotate .15s ease-out}
details[open] summary::before{rotate:45deg}
details summary span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* --- code, commands, forms ----------------------------------------------------------- */
code{font-size:12.5px;background:var(--paper-2);border:1px solid var(--rule);border-radius:6px;padding:1px 6px}
pre{font-size:12px;line-height:1.6;background:var(--paper-2);border:1px solid var(--rule);border-radius:10px;padding:12px 14px;overflow-x:auto;white-space:pre-wrap;word-break:break-word;margin:8px 0 0}
pre.night{background:var(--night);color:#fff;border-color:transparent;white-space:pre}
.cmd{display:flex;align-items:center;gap:8px;background:var(--night);color:#fff;border-radius:10px;padding:6px 6px 6px 14px;margin:8px 0;min-width:0}
@media (prefers-color-scheme:dark){.cmd,pre.night{border:1px solid var(--rule)}}
.cmd code{flex:1;min-width:0;background:none;border:0;padding:6px 0;color:#fff;font-size:12.5px;white-space:nowrap;overflow-x:auto;scrollbar-width:none}
.cmd code::-webkit-scrollbar{display:none}
.cmd .prompt{color:rgb(255 255 255/.35);user-select:none}
.cmd button{height:28px;padding:0 10px;font-size:12px;background:rgb(255 255 255/.08);color:rgb(255 255 255/.85);border:1px solid rgb(255 255 255/.12);box-shadow:none}
.cmd button:hover{background:rgb(255 255 255/.14);color:#fff}
.cmd button .i{width:13px;height:13px}
textarea{width:100%;min-height:150px;font:12.5px/1.6 "Geist Mono",ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--paper);color:var(--ink);border:1px solid var(--rule);border-radius:10px;padding:12px 14px;resize:vertical;transition:border-color .15s ease-out,box-shadow .15s ease-out}
input[type=text],input[type=email],input[type=password],input[type=number],select{width:100%;height:38px;font:inherit;font-size:14px;background:var(--paper);color:var(--ink);border:1px solid var(--rule);border-radius:8px;padding:0 12px;transition:border-color .15s ease-out,box-shadow .15s ease-out}
textarea:focus,input:focus,select:focus{outline:none;border-color:var(--ink-3);box-shadow:0 0 0 3px var(--sel)}
label.field{display:block;font-size:13px;font-weight:500;margin:14px 0 6px;color:var(--ink)}
.notice{display:flex;align-items:flex-start;gap:10px;margin:0 0 16px;padding:11px 14px;border:1px solid color-mix(in srgb,var(--ok) 32%,var(--rule));background:color-mix(in srgb,var(--ok) 7%,var(--surface));border-radius:10px;font-size:13.5px}
.notice::before{content:"";flex:none;width:7px;height:7px;margin-top:7px;border-radius:50%;background:var(--ok)}
.notice.error{border-color:color-mix(in srgb,var(--bad) 32%,var(--rule));background:color-mix(in srgb,var(--bad) 6%,var(--surface))}
.notice.error::before{background:var(--bad)}
div.notice{display:block}
div.notice::before{display:none}
.meter{height:6px;background:var(--paper-2);border:1px solid var(--rule-2);border-radius:999px;overflow:hidden;margin:2px 0 6px}
.meter>span{display:block;height:100%;background:var(--ink);border-radius:999px}
.meter.warn>span{background:var(--warn)}

/* --- segmented filters ----------------------------------------------------------------- */
.filters{display:inline-flex;gap:2px;flex-wrap:wrap;padding:3px;background:var(--paper-2);border:1px solid var(--rule);border-radius:10px}
.filters a{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 11px;border-radius:7px;font-size:13px;font-weight:500;color:var(--ink-2);transition:background-color .15s ease-out,color .15s ease-out}
.filters a:hover{color:var(--ink)}
.filters a[aria-current=true]{background:var(--surface);color:var(--ink);box-shadow:var(--lift),0 0 0 1px var(--rule)}
.toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:16px}

/* --- steps --------------------------------------------------------------------------- */
.steps{counter-reset:step;list-style:none;margin:0;padding:0}
.steps li{counter-increment:step;position:relative;padding:7px 0 7px 36px;font-size:14px;color:var(--ink-2)}
.steps li::before{content:counter(step);position:absolute;left:0;top:7px;width:24px;height:24px;border-radius:50%;border:1px solid var(--rule);background:var(--chip);display:grid;place-items:center;font-size:12px;font-weight:500;color:var(--ink-2);font-variant-numeric:tabular-nums}
.steps li strong,.steps li em{color:var(--ink)}
.pager{display:flex;justify-content:flex-end;margin-top:14px}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
`;

function renderNav(active: string): string {
  const link = (page: NavLink) =>
    `<a href="${page.path}"${page.path === active ? ' aria-current="page"' : ""}>${page.icon ? icon(page.icon) : ""}<span>${page.label}</span></a>`;
  return `${NAV.map(link).join("")}${extraNav.length ? `<span class="nav-sep" role="separator"></span>${extraNav.map(link).join("")}` : ""}`;
}

function brand(href: string, withInstance = false): string {
  return `<a class="brand" href="${href}" translate="no">${icon("horn")}<span>unicorn</span>${withInstance ? `<span class="instance">${instanceLabel}</span>` : ""}</a>`;
}

const ext = icon("external", "i ext");

function head(title: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="#f5f4ef" media="(prefers-color-scheme: light)">
  <meta name="theme-color" content="#0b0b0c" media="(prefers-color-scheme: dark)">
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
    <section class="door-night" aria-label="About unicorn">
      ${brand("/")}
      <div>
        <p class="door-title">Campus, <span class="text-spectrum">remembered.</span></p>
        <p class="door-lede">unicorn reads Ed, Moodle, Canvas and Gmail every hour, remembers what each one said, and tells the AI you already use what changed. It has no model of its own.</p>
        <div class="door-links">
          <a class="button night-outline" href="${SITE}" target="_blank" rel="noopener">How it works ${icon("external")}</a>
          <a class="button night-outline" href="${DOCS}" target="_blank" rel="noopener">Docs ${icon("external")}</a>
        </div>
      </div>
      <div class="door-meta">${options.actions ?? ""}</div>
    </section>
    <main class="door-form"><div class="inner">
      <h1>${options.heading}</h1>
      <p class="sub">${options.subtitle}</p>
      ${options.body}
    </div></main>
  </div>
</body>
</html>`;
  }
  return `${head(options.title)}
<body>
  <div class="shell">
    <aside class="side">
      ${brand(brandHref, true)}
      <nav class="nav" aria-label="Dashboard">${renderNav(options.active)}</nav>
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
      <footer class="foot"><span>unicorn · open source under Apache 2.0</span><span><a href="${DOCS}" target="_blank" rel="noopener">Docs</a> · <a href="https://github.com/TuuHub/unicorn" target="_blank" rel="noopener">GitHub</a></span></footer>
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
