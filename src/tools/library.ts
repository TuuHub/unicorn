// The tool library (ADR-0035 §9): a GitHub repo, `unicorn-tools`, with an
// `index.json` naming a JSON file per tool. browse_tools reads the index,
// install_tool imports one tool through the same guards as define_tool,
// publish_tool hands the caller's own agent a PR-ready payload. The Worker
// never writes to GitHub — no token, no API call that mutates anything.

import type { DefineToolInput, UserToolDefinition, UserToolInputSchema } from "./user-tools";

export const DEFAULT_TOOLS_REPO = "TuuHub/unicorn-tools";
const CACHE_TTL_MS = 10 * 60 * 1000;

export interface LibraryToolEntry {
  name: string;
  description: string;
  path: string; // e.g. "tools/next_lab.json", relative to the repo root
}

export interface LibraryIndex {
  tools: LibraryToolEntry[];
}

export interface LibraryToolFile {
  name: string;
  description: string;
  inputSchema: UserToolInputSchema;
  sql: string;
}

export type Fetcher = (url: string) => Promise<Response>;

interface CacheEntry {
  repo: string;
  fetchedAt: number;
  index: LibraryIndex;
}

// Module-level, per-isolate cache (ADR-0035: "cached 10 min in the settings
// table or memory") — a single-user Worker doesn't need cross-isolate
// coherency for a read-only, 10-minute-stale GitHub index.
let cache: CacheEntry | null = null;

// Exposed for tests only; production never needs to reset this by hand.
export function clearLibraryCache(): void {
  cache = null;
}

export async function resolveToolsRepo(db: D1Database): Promise<string> {
  const row = await db.prepare("SELECT value_json FROM settings WHERE key = 'tools_repo'").first<{ value_json: string }>();
  if (!row) {
    return DEFAULT_TOOLS_REPO;
  }
  try {
    const parsed = JSON.parse(row.value_json) as { repo?: unknown };
    return typeof parsed.repo === "string" && parsed.repo.trim() ? parsed.repo.trim() : DEFAULT_TOOLS_REPO;
  } catch {
    return DEFAULT_TOOLS_REPO;
  }
}

async function fetchJson(url: string, fetchImpl: Fetcher): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url);
  } catch (error) {
    throw new Error(`Could not reach ${url}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${response.status}.`);
  }
  return response.json();
}

export async function browseTools(repo: string, fetchImpl: Fetcher = fetch, query?: string): Promise<LibraryIndex> {
  if (!cache || cache.repo !== repo || Date.now() - cache.fetchedAt >= CACHE_TTL_MS) {
    const index = (await fetchJson(`https://raw.githubusercontent.com/${repo}/main/index.json`, fetchImpl)) as LibraryIndex;
    cache = { repo, fetchedAt: Date.now(), index };
  }
  if (!query) {
    return cache.index;
  }
  const needle = query.toLowerCase();
  return { tools: cache.index.tools.filter((tool) => tool.name.toLowerCase().includes(needle) || tool.description.toLowerCase().includes(needle)) };
}

export async function fetchLibraryTool(repo: string, entry: LibraryToolEntry, fetchImpl: Fetcher = fetch): Promise<LibraryToolFile> {
  return (await fetchJson(`https://raw.githubusercontent.com/${repo}/main/${entry.path}`, fetchImpl)) as LibraryToolFile;
}

export async function installTool(
  repo: string,
  name: string,
  define: (input: DefineToolInput) => Promise<UserToolDefinition>,
  fetchImpl: Fetcher = fetch,
): Promise<UserToolDefinition> {
  const index = await browseTools(repo, fetchImpl);
  const entry = index.tools.find((tool) => tool.name === name);
  if (!entry) {
    throw new Error(`"${name}" is not listed in ${repo}'s index.json. Call browse_tools to see what's available.`);
  }
  const file = await fetchLibraryTool(repo, entry, fetchImpl);
  return define({ name: file.name, description: file.description, inputSchema: file.inputSchema, sql: file.sql });
}

export interface PublishPayload {
  path: string;
  content: string;
  indexEntry: LibraryToolEntry;
  ghCommands: string[];
}

// A PR-ready payload, not a PR: the Worker has no GitHub credential and
// never calls GitHub's write API. The caller's own agent runs these `gh`
// commands (it already has the user's `gh auth login`, unicorn does not).
export function buildPublishPayload(repo: string, tool: UserToolDefinition): PublishPayload {
  const path = `tools/${tool.name}.json`;
  const content = `${JSON.stringify({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema, sql: tool.sql }, null, 2)}\n`;
  const indexEntry: LibraryToolEntry = { name: tool.name, description: tool.description, path };
  const branch = `add-${tool.name}`;
  const repoDir = repo.split("/")[1] ?? repo;
  const ghCommands = [
    `git clone https://github.com/${repo}.git ${repoDir} && cd ${repoDir}`,
    `git checkout -b ${branch}`,
    `mkdir -p tools`,
    `cat > ${path} <<'EOF'\n${content}EOF`,
    `# add this entry to index.json's "tools" array: ${JSON.stringify(indexEntry)}`,
    `git add ${path} index.json`,
    `git commit -m "feat: add ${tool.name} tool"`,
    `git push -u origin ${branch}`,
    `gh pr create --repo ${repo} --title "Add ${tool.name} tool" --body "Adds the ${tool.name} user tool."`,
  ];
  return { path, content, indexEntry, ghCommands };
}
