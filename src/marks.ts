// Marks for the rendered pages (ADR-0026 still holds: inline SVG strings, no assets, nothing the
// CSP has to allow). Three families, all on a 24-unit grid:
//
//   ICONS   the panel's own line glyphs, 1.5 stroke in the text colour, after the family marks on
//           unicorn.tuuhub.com (src/lib/brand.ts in unicorn-site)
//   SOURCES one glyph per campus system, each with the hue the landing page gives that source
//   CLIENTS the AI apps that call unicorn, so a row in Activity or a card on Connect reads at a
//           glance. Brand paths are from Simple Icons (CC0); they identify the client and nothing
//           more. Anything unknown gets a monogram tile.

// ui.ts imports this module, so this one keeps its own escaper rather than importing back.
function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

type IconName =
  | "overview" | "activity" | "memory" | "connect" | "sources" | "account" | "docs" | "external"
  | "arrow" | "check" | "copy" | "key" | "clock" | "sync" | "spark" | "calendar" | "units" | "agents"
  | "signout" | "alert" | "plus" | "horn" | "changes" | "brief" | "plan" | "search" | "playbook" | "server" | "download" | "chevron";

const ICON_PATHS: Record<IconName, string[]> = {
  horn: ["M12 2.5 17.5 20a5.5 2 0 0 1-11 0Z", "M8.4 14.4q3.6 1.9 7.4-.6M10.1 9q2.2 1.2 4.3-.4"],
  overview: ["M4 4.5h6.5V11H4z", "M13.5 4.5H20V8h-6.5z", "M13.5 11H20v8.5h-6.5z", "M4 14h6.5v5.5H4z"],
  activity: ["M3 12h3.5l2.5-6.5 5 13 2.5-6.5H21"],
  memory: ["M6.5 3.5h10.5a1.5 1.5 0 0 1 1.5 1.5v14a1.5 1.5 0 0 1-1.5 1.5H6.5z", "M6.5 3.5v17", "M9.5 8H15.5M9.5 11.5h4"],
  connect: ["M9 3v4M15 3v4", "M6.5 7h11v3.5a5.5 5.5 0 0 1-11 0z", "M12 16v5"],
  sources: ["M12 3.5 3.5 8 12 12.5 20.5 8z", "M3.5 12 12 16.5 20.5 12", "M3.5 16 12 20.5 20.5 16"],
  account: ["M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z", "M4.5 20.5a7.5 7.5 0 0 1 15 0"],
  docs: ["M12 6.5c-1.6-1.4-4.2-2-7.5-2v13c3.3 0 5.9.6 7.5 2 1.6-1.4 4.2-2 7.5-2v-13c-3.3 0-5.9.6-7.5 2z", "M12 6.5v13"],
  external: ["M8 16 16 8", "M9.5 8H16v6.5"],
  arrow: ["M5 12h14", "M13.5 6.5 19 12l-5.5 5.5"],
  check: ["M5 12.5 9.5 17 19 7.5"],
  copy: ["M8.5 8.5h10v10h-10z", "M15.5 8.5v-3h-10v10h3"],
  key: ["M8.5 15.5a4 4 0 1 1 3.4-6.1L20.5 9.5v3.5h-2.5v2.5h-3V13l-3.1 0a4 4 0 0 1-3.4 2.5z", "M7.5 11.5h.01"],
  clock: ["M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17z", "M12 7.5V12l3 2"],
  sync: ["M19.5 12a7.5 7.5 0 0 1-13.1 5", "M4.5 12a7.5 7.5 0 0 1 13.1-5", "M17.5 3.5v3.6h-3.6", "M6.5 20.5v-3.6h3.6"],
  spark: ["M12 3.5v4M12 16.5v4M3.5 12h4M16.5 12h4", "M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18"],
  calendar: ["M4.5 6h15v14h-15z", "M4.5 10h15", "M8.5 3.5v4M15.5 3.5v4"],
  units: ["M2.5 9.5 12 5l9.5 4.5L12 14Z", "M6.5 11.8v4.1c0 1.4 2.5 2.8 5.5 2.8s5.5-1.4 5.5-2.8v-4.1"],
  agents: ["M8.5 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6z", "M3 19.5a5.5 5.5 0 0 1 11 0", "M15.5 5.2a3 3 0 0 1 0 5.6", "M17.5 14.3a5.5 5.5 0 0 1 3.5 5.2"],
  signout: ["M14 4.5h4.5a1.5 1.5 0 0 1 1.5 1.5v12a1.5 1.5 0 0 1-1.5 1.5H14", "M10 8l-4 4 4 4", "M6 12h9"],
  alert: ["M12 3.5 21 19.5H3z", "M12 10v4", "M12 16.8h.01"],
  plus: ["M12 5v14M5 12h14"],
  changes: ["M4 7h12.5", "M13.5 4l3 3-3 3", "M20 17H7.5", "M10.5 14l-3 3 3 3"],
  brief: ["M4.5 5.5h15v13h-15z", "M4.5 6 12 12l7.5-6"],
  plan: ["M5 4.5h14v15H5z", "M8.5 9l1.5 1.5 3-3", "M8.5 15h7"],
  search: ["M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13z", "M15.5 15.5 20 20"],
  playbook: ["M7 4.5v15l5.5-3.5 5.5 3.5v-15z"],
  server: ["M4 4.5h16v6H4z", "M4 13.5h16v6H4z", "M7.5 7.5h.01M7.5 16.5h.01"],
  download: ["M12 4v11", "M7.5 10.5 12 15l4.5-4.5", "M4.5 19.5h15"],
  chevron: ["M9 6l6 6-6 6"],
};

export function icon(name: IconName, className = "i"): string {
  return `<svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name]
    .map((d) => `<path d="${d}"/>`)
    .join("")}</svg>`;
}

// --- sources --------------------------------------------------------------------------------

export interface SourceMark {
  id: string;
  name: string;
  hue: string;
  paths: string[];
}

// Hues are the landing page's, in spectral order (unicorn-site src/app/globals.css).
const SOURCE_MARKS: Record<string, SourceMark> = {
  moodle: { id: "moodle", name: "Moodle", hue: "#ff5a4f", paths: ["M2.5 9.5 12 5l9.5 4.5L12 14Z", "M6.5 11.8v4.1c0 1.4 2.5 2.8 5.5 2.8s5.5-1.4 5.5-2.8v-4.1", "M21.5 9.5v5.5"] },
  ed: {
    id: "ed",
    name: "Ed",
    hue: "#ffb02e",
    paths: ["M4.5 4.5h9a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H9l-3.5 3v-3h-1a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2Z", "M17.5 9h2a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-1v3l-3.5-3h-3.5"],
  },
  canvas: {
    id: "canvas",
    name: "Canvas",
    hue: "#5fd47a",
    paths: ["M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17z", "M12 7.5v.01M12 16.5v.01M7.5 12h.01M16.5 12h.01", "M8.8 8.8h.01M15.2 15.2h.01M15.2 8.8h.01M8.8 15.2h.01"],
  },
  gmail: { id: "gmail", name: "Gmail", hue: "#4aa8ff", paths: ["M3.5 6h17v12.5h-17z", "M3.5 6.5 12 13l8.5-6.5"] },
  feeds: { id: "feeds", name: "Feeds", hue: "#a77bff", paths: ["M5 19a.5.5 0 1 0 0-1 .5.5 0 0 0 0 1z", "M4.5 11.5a8 8 0 0 1 8 8", "M4.5 5a14.5 14.5 0 0 1 14.5 14.5"] },
};

const SOURCE_ALIASES: Record<string, string> = {
  "campus-moodle": "moodle",
  "campus-ed": "ed",
  "campus-canvas": "canvas",
  edstem: "ed",
  "ed discussion": "ed",
  gmail: "gmail",
};

export function sourceMark(idOrName: string): SourceMark | null {
  const key = idOrName.trim().toLowerCase();
  return SOURCE_MARKS[SOURCE_ALIASES[key] ?? key] ?? null;
}

/** A small tile in the source's hue with its glyph in ink. */
export function sourceTile(idOrName: string, size: "sm" | "md" | "lg" = "md"): string {
  const mark = sourceMark(idOrName);
  if (!mark) return `<span class="tile-mark ${size} mono" aria-hidden="true">${escapeHtml(idOrName.slice(0, 1).toUpperCase())}</span>`;
  return `<span class="tile-mark ${size} src" style="--hue:${mark.hue}" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${mark.paths
    .map((d) => `<path d="${d}"/>`)
    .join("")}</svg></span>`;
}

/** A dot in the source's hue, for inline mentions ("FIT2004 · Moodle · Ed"). */
export function sourceDot(idOrName: string): string {
  const mark = sourceMark(idOrName);
  return `<span class="src-dot" style="--hue:${mark?.hue ?? "var(--ink-3)"}" aria-hidden="true"></span>`;
}

// --- AI clients -----------------------------------------------------------------------------

export interface ClientMark {
  id: string;
  name: string;
  /** Brand colour for the glyph; null draws it in ink so it holds in light and dark. */
  color: string | null;
  path: string | null;
}

const LOGOS = {
  claude: "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z",
  claudecode: "M21 10.5h3v3h-3v3h-1.5v3H18v-3h-1.5v3H15v-3H9v3H7.5v-3H6v3H4.5v-3H3v-3H0v-3h3v-6h18Zm-15 0h1.5v-3H6Zm10.5 0H18v-3h-1.5z",
  openai: "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z",
  cursor: "M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23",
  windsurf: "M23.55 5.067c-1.2038-.002-2.1806.973-2.1806 2.1765v4.8676c0 .972-.8035 1.7594-1.7597 1.7594-.568 0-1.1352-.286-1.4718-.7659l-4.9713-7.1003c-.4125-.5896-1.0837-.941-1.8103-.941-1.1334 0-2.1533.9635-2.1533 2.153v4.8957c0 .972-.7969 1.7594-1.7596 1.7594-.57 0-1.1363-.286-1.4728-.7658L.4076 5.1598C.2822 4.9798 0 5.0688 0 5.2882v4.2452c0 .2147.0656.4228.1884.599l5.4748 7.8183c.3234.462.8006.8052 1.3509.9298 1.3771.313 2.6446-.747 2.6446-2.0977v-4.893c0-.972.7875-1.7593 1.7596-1.7593h.003a1.798 1.798 0 0 1 1.4718.7658l4.9723 7.0994c.4135.5905 1.05.941 1.8093.941 1.1587 0 2.1515-.9645 2.1515-2.153v-4.8948c0-.972.7875-1.7594 1.7596-1.7594h.194a.22.22 0 0 0 .2204-.2202v-4.622a.22.22 0 0 0-.2203-.2203Z",
  gemini: "M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81",
  copilot: "M23.922 16.997C23.061 18.492 18.063 22.02 12 22.02 5.937 22.02.939 18.492.078 16.997A.641.641 0 0 1 0 16.741v-2.869a.883.883 0 0 1 .053-.22c.372-.935 1.347-2.292 2.605-2.656.167-.429.414-1.055.644-1.517a10.098 10.098 0 0 1-.052-1.086c0-1.331.282-2.499 1.132-3.368.397-.406.89-.717 1.474-.952C7.255 2.937 9.248 1.98 11.978 1.98c2.731 0 4.767.957 6.166 2.093.584.235 1.077.546 1.474.952.85.869 1.132 2.037 1.132 3.368 0 .368-.014.733-.052 1.086.23.462.477 1.088.644 1.517 1.258.364 2.233 1.721 2.605 2.656a.841.841 0 0 1 .053.22v2.869a.641.641 0 0 1-.078.256Zm-11.75-5.992h-.344a4.359 4.359 0 0 1-.355.508c-.77.947-1.918 1.492-3.508 1.492-1.725 0-2.989-.359-3.782-1.259a2.137 2.137 0 0 1-.085-.104L4 11.746v6.585c1.435.779 4.514 2.179 8 2.179 3.486 0 6.565-1.4 8-2.179v-6.585l-.098-.104s-.033.045-.085.104c-.793.9-2.057 1.259-3.782 1.259-1.59 0-2.738-.545-3.508-1.492a4.359 4.359 0 0 1-.355-.508Zm2.328 3.25c.549 0 1 .451 1 1v2c0 .549-.451 1-1 1-.549 0-1-.451-1-1v-2c0-.549.451-1 1-1Zm-5 0c.549 0 1 .451 1 1v2c0 .549-.451 1-1 1-.549 0-1-.451-1-1v-2c0-.549.451-1 1-1Zm3.313-6.185c.136 1.057.403 1.913.878 2.497.442.544 1.134.938 2.344.938 1.573 0 2.292-.337 2.657-.751.384-.435.558-1.15.558-2.361 0-1.14-.243-1.847-.705-2.319-.477-.488-1.319-.862-2.824-1.025-1.487-.161-2.192.138-2.533.529-.269.307-.437.808-.438 1.578v.021c0 .265.021.562.063.893Zm-1.626 0c.042-.331.063-.628.063-.894v-.02c-.001-.77-.169-1.271-.438-1.578-.341-.391-1.046-.69-2.533-.529-1.505.163-2.347.537-2.824 1.025-.462.472-.705 1.179-.705 2.319 0 1.211.175 1.926.558 2.361.365.414 1.084.751 2.657.751 1.21 0 1.902-.394 2.344-.938.475-.584.742-1.44.878-2.497Z",
  vscode: "M23.15 2.587L18.21.21a1.494 1.494 0 0 0-1.705.29l-9.46 8.63-4.12-3.128a.999.999 0 0 0-1.276.057L.327 7.261A1 1 0 0 0 .326 8.74L3.899 12 .326 15.26a1 1 0 0 0 .001 1.479L1.65 17.94a.999.999 0 0 0 1.276.057l4.12-3.128 9.46 8.63a1.492 1.492 0 0 0 1.704.29l4.942-2.377A1.5 1.5 0 0 0 24 20.06V3.939a1.5 1.5 0 0 0-.85-1.352zm-5.146 14.861L10.826 12l7.178-5.448v10.896z",
  zed: "M2.25 1.5a.75.75 0 0 0-.75.75v16.5H0V2.25A2.25 2.25 0 0 1 2.25 0h20.095c1.002 0 1.504 1.212.795 1.92L10.764 14.298h3.486V12.75h1.5v1.922a1.125 1.125 0 0 1-1.125 1.125H9.264l-2.578 2.578h11.689V9h1.5v9.375a1.5 1.5 0 0 1-1.5 1.5H5.185L2.562 22.5H21.75a.75.75 0 0 0 .75-.75V5.25H24v16.5A2.25 2.25 0 0 1 21.75 24H1.655C.653 24 .151 22.788.86 22.08L13.19 9.75H9.75v1.5h-1.5V9.375A1.125 1.125 0 0 1 9.375 8.25h5.314l2.625-2.625H5.625V15h-1.5V5.625a1.5 1.5 0 0 1 1.5-1.5h13.19L21.438 1.5z",
  cline: "m23.365 13.556-1.442-2.895V8.994c0-2.764-2.218-5.002-4.954-5.002h-2.464c.178-.367.276-.779.276-1.213A2.77 2.77 0 0 0 12.018 0a2.77 2.77 0 0 0-2.763 2.779c0 .434.098.846.276 1.213H7.067c-2.736 0-4.954 2.238-4.954 5.002v1.667L.64 13.549c-.149.29-.149.636 0 .927l1.472 2.855v1.667C2.113 21.762 4.33 24 7.067 24h9.902c2.736 0 4.954-2.238 4.954-5.002V17.33l1.44-2.865c.143-.286.143-.622.002-.91m-12.854 2.36a2.27 2.27 0 0 1-2.261 2.273 2.27 2.27 0 0 1-2.261-2.273v-4.042A2.27 2.27 0 0 1 8.249 9.6a2.267 2.267 0 0 1 2.262 2.274zm7.285 0a2.27 2.27 0 0 1-2.26 2.273 2.27 2.27 0 0 1-2.262-2.273v-4.042A2.267 2.267 0 0 1 15.535 9.6a2.267 2.267 0 0 1 2.261 2.274z",
  perplexity: "M22.3977 7.0896h-2.3106V.0676l-7.5094 6.3542V.1577h-1.1554v6.1966L4.4904 0v7.0896H1.6023v10.3976h2.8882V24l6.932-6.3591v6.2005h1.1554v-6.0469l6.9318 6.1807v-6.4879h2.8882V7.0896zm-3.4657-4.531v4.531h-5.355l5.355-4.531zm-13.2862.0676 4.8691 4.4634H5.6458V2.6262zM2.7576 16.332V8.245h7.8476l-6.1149 6.1147v1.9723H2.7576zm2.8882 5.0404v-3.8852h.0001v-2.6488l5.7763-5.7764v7.0111l-5.7764 5.2993zm12.7086.0248-5.7766-5.1509V9.0618l5.7766 5.7766v6.5588zm2.8882-5.0652h-1.733v-1.9723L13.3948 8.245h7.8478v8.087z",
  raycast: "M6.004 15.492v2.504L0 11.992l1.258-1.249Zm2.504 2.504H6.004L12.008 24l1.253-1.253zm14.24-4.747L24 11.997 12.003 0 10.75 1.251 15.491 6h-2.865L9.317 2.692 8.065 3.944l2.06 2.06H8.691v9.31H18v-1.432l2.06 2.06 1.252-1.252-3.312-3.32V8.506ZM6.63 5.372 5.38 6.625l1.342 1.343 1.251-1.253Zm10.655 10.655-1.247 1.251 1.342 1.343 1.253-1.251zM3.944 8.059 2.692 9.31l3.312 3.314v-2.506zm9.936 9.937h-2.504l3.314 3.312 1.25-1.252z",
} as const;

const CLIENTS: Array<ClientMark & { match: string[] }> = [
  { id: "claude-code", name: "Claude Code", color: "#D97757", path: LOGOS.claudecode, match: ["claude code", "claude-code", "claudecode"] },
  { id: "claude", name: "Claude", color: "#D97757", path: LOGOS.claude, match: ["claude", "anthropic"] },
  { id: "codex", name: "Codex", color: null, path: LOGOS.openai, match: ["codex"] },
  { id: "chatgpt", name: "ChatGPT", color: null, path: LOGOS.openai, match: ["chatgpt", "openai"] },
  { id: "cursor", name: "Cursor", color: null, path: LOGOS.cursor, match: ["cursor"] },
  { id: "windsurf", name: "Windsurf", color: null, path: LOGOS.windsurf, match: ["windsurf", "codeium"] },
  { id: "gemini", name: "Gemini", color: "#8E75B2", path: LOGOS.gemini, match: ["gemini", "google"] },
  { id: "copilot", name: "GitHub Copilot", color: null, path: LOGOS.copilot, match: ["copilot", "github"] },
  { id: "vscode", name: "VS Code", color: "#0A7ACA", path: LOGOS.vscode, match: ["visual studio code", "vscode", "vs code"] },
  { id: "zed", name: "Zed", color: "#084CCF", path: LOGOS.zed, match: ["zed"] },
  { id: "cline", name: "Cline", color: null, path: LOGOS.cline, match: ["cline"] },
  { id: "perplexity", name: "Perplexity", color: "#1FB8CD", path: LOGOS.perplexity, match: ["perplexity"] },
  { id: "raycast", name: "Raycast", color: "#FF6363", path: LOGOS.raycast, match: ["raycast"] },
];

/**
 * Which app an actor string names. Actors are an OAuth client's self-registered name
 * ("Claude", "claude-ai", "ChatGPT", "Cursor") or what actorFromUserAgent guessed.
 */
export function clientMark(actor: string | null | undefined): ClientMark {
  const raw = (actor ?? "").trim();
  const lower = raw.toLowerCase();
  if (lower === "mcp_token" || lower === "bearer token" || lower === "personal access token") {
    return { id: "token", name: "Bearer token", color: null, path: null };
  }
  if (lower === "panel" || lower === "unicorn") {
    return { id: "unicorn", name: "You, in the panel", color: null, path: null };
  }
  if (lower === "cron" || lower === "scheduler" || lower === "schedule") {
    return { id: "scheduler", name: "Hourly sync", color: null, path: null };
  }
  const known = CLIENTS.find((client) => client.match.some((needle) => lower.includes(needle)));
  if (known) {
    const { match: _match, ...mark } = known;
    return mark;
  }
  return { id: "other", name: raw || "Unknown client", color: null, path: null };
}

/** The client's logo in a small hairline tile; a glyph or monogram when there is no logo. */
export function clientTile(actor: string | null | undefined, size: "sm" | "md" | "lg" = "md"): string {
  const mark = clientMark(actor);
  let inner: string;
  if (mark.path) {
    const fill = mark.color ? ` style="color:${mark.color}"` : "";
    inner = `<svg viewBox="0 0 24 24" fill="currentColor"${fill}><path d="${mark.path}"/></svg>`;
  } else if (mark.id === "token") {
    inner = icon("key", "");
  } else if (mark.id === "unicorn") {
    inner = icon("horn", "");
  } else if (mark.id === "scheduler") {
    inner = icon("sync", "");
  } else {
    const letter = (mark.name.match(/[a-z0-9]/i)?.[0] ?? "?").toUpperCase();
    return `<span class="tile-mark ${size} mono" aria-hidden="true">${escapeHtml(letter)}</span>`;
  }
  return `<span class="tile-mark ${size} client client-${mark.id}" aria-hidden="true">${inner}</span>`;
}

/** Logo and name together, as one inline unit. */
export function clientLabel(actor: string | null | undefined, size: "sm" | "md" = "sm"): string {
  const mark = clientMark(actor);
  const raw = (actor ?? "").trim();
  // Keep the client's own spelling when it named itself something more specific ("Claude Desktop").
  const name = mark.id === "other" || mark.id === "token" || mark.id === "unicorn" || mark.id === "scheduler" || !raw ? mark.name : raw;
  return `<span class="who">${clientTile(actor, size)}<span class="who-name">${escapeHtml(name)}</span></span>`;
}

// --- change events ----------------------------------------------------------------------------

// The glyphs unicorn's own changes widget draws (and unicorn-site's widget copies), 16-unit grid.
const EVENT_PATHS: Record<string, string[]> = {
  "item.added": ["M8 3v10M3 8h10"],
  "item.archived": ["M2.5 4.5h11v2.5h-11z", "M3.5 7v6h9V7", "M6.5 9.5h3"],
  "item.restored": ["M3.5 8a4.5 4.5 0 1 0 1.4-3.3", "M3.5 2.5v2.5H6"],
  "deadline.changed": ["M8 13.5a5 5 0 1 0 0-10 5 5 0 0 0 0 10z", "M8 6v3l2 1.2"],
  "grade.changed": ["M8 2.5 9.6 6l3.7.4-2.8 2.5.8 3.6L8 10.6l-3.3 1.9.8-3.6L2.7 6.4 6.4 6 8 2.5Z"],
  "content.changed": ["M11.5 2.5 13 4l-7 7-2.5.5.5-2.5 7-7Z"],
  "notice.posted": ["M3 8.5v-1A5 5 0 0 1 8 2.5h0a5 5 0 0 1 5 5v1", "M2.5 8.5h11v2a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-2Z", "M7 13.5a1 1 0 0 0 2 0"],
  "state.changed": ["M4 6h6M8 4l2 2-2 2", "M12 10H6M8 8l-2 2 2 2"],
};

export const EVENT_LABELS: Record<string, string> = {
  "item.added": "New",
  "deadline.changed": "Deadline moved",
  "grade.changed": "Grade",
  "notice.posted": "Notice",
  "content.changed": "Edited",
  "state.changed": "Status",
  "item.archived": "Removed",
  "item.restored": "Restored",
};

export function eventIcon(type: string): string {
  const paths = EVENT_PATHS[type] ?? EVENT_PATHS["content.changed"];
  return `<span class="tile-mark sm ev ev-${escapeHtml(type.replace(/\W/g, "-"))}" aria-hidden="true"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">${paths
    .map((d) => `<path d="${d}"/>`)
    .join("")}</svg></span>`;
}
