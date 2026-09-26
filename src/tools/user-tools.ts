// User-defined SQL tools (ADR-0035, ARCHITECTURE.md §9). A user tool is
// data — name, description, input schema, one read-only SQL statement over
// five fixed views — never code. The guard below is mechanical (an
// allowlist tokenizer), not model-judged: it must hold against adversarial
// SQL, not just well-formed mistakes.
//
// Everything here is model-facing output: define_tool errors quote the
// offending SQL fragment and say how to fix it, and door tool calls render
// a compact table plus structuredContent, so any client model can repair
// its own SQL in one retry.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const READ_ONLY = { destructiveHint: false, readOnlyHint: true } as const;

export const MAX_TOOLS = 20;
export const MAX_SQL_LENGTH = 4_000;
export const MAX_DESCRIPTION_LENGTH = 500;
export const MAX_PARAMS = 10;
export const RESULT_ROW_LIMIT = 200;
export const RESULT_TEXT_BUDGET_BYTES = 50_000;

// The only tables a user tool's SQL may name after FROM/JOIN. Kept as both
// an ordered array (describe_schema iterates it) and a Set (guard lookups).
export const ALLOWED_VIEWS = ["v_items", "v_upcoming", "v_changes", "v_courses", "v_buckets"] as const;
const ALLOWED_VIEW_SET = new Set<string>(ALLOWED_VIEWS);

// The door's own fixed tools (ADR-0035 §7) — a user tool can never shadow one.
export const RESERVED_DOOR_TOOL_NAMES = new Set([
  "get_briefs",
  "ack_briefs",
  "write_brief",
  "changes_since",
  "course",
  "life",
  "search_items",
  "get_plan",
  "save_plan",
  "remember",
  "run_playbook",
  "label_items",
  "status",
]);

const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{2,39}$/;
const PARAM_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

// Bare keywords that must never appear as their own token, anywhere outside
// a string literal — the allowlist below already keeps FROM/JOIN off raw
// tables, this is the second, cheaper net for write/introspection vocabulary
// a read-only tool has no business using at all.
const FORBIDDEN_KEYWORDS = new Set([
  "insert",
  "update",
  "delete",
  "replace",
  "create",
  "drop",
  "alter",
  "vacuum",
  "reindex",
  "attach",
  "detach",
  "pragma",
  "recursive",
]);

// Function calls that reach outside plain SQL even when not used as a
// FROM/JOIN target (e.g. `SELECT load_extension('x')` in the select list).
const FORBIDDEN_FUNCTIONS = new Set(["load_extension"]);

export type UserToolParamType = "string" | "number" | "integer" | "boolean";

export interface UserToolParam {
  type: UserToolParamType;
  description?: string;
  enum?: Array<string | number>;
  default?: string | number | boolean;
}

export type UserToolInputSchema = Record<string, UserToolParam>;

export interface UserToolDefinition {
  name: string;
  description: string;
  inputSchema: UserToolInputSchema;
  sql: string; // canonical: guard-checked, trailing ';' stripped, never wrapped
  createdAt: string;
  updatedAt: string;
}

export interface DefineToolInput {
  name: string;
  description: string;
  inputSchema: UserToolInputSchema;
  sql: string;
}

// The shape every error from this module takes, so a client model can parse
// it without special-casing: quote the fragment, say the fix.
export interface ToolError {
  code: string;
  message: string;
  hint: string;
}

export class ToolGuardError extends Error {
  readonly toolError: ToolError;
  constructor(toolError: ToolError) {
    super(toolError.message);
    this.name = "ToolGuardError";
    this.toolError = toolError;
  }
}

function guardError(code: string, message: string, hint: string): ToolGuardError {
  return new ToolGuardError({ code, message, hint });
}

// A short, whitespace-collapsed window of the original SQL around `index`,
// quoted in every guard error so a model can locate the offending piece
// without re-deriving it from a generic message.
function fragment(sql: string, index: number, radius = 30): string {
  const from = Math.max(0, index - 10);
  const to = Math.min(sql.length, index + radius);
  const text = sql.slice(from, to).replace(/\s+/g, " ").trim();
  return `${from > 0 ? "…" : ""}${text}${to < sql.length ? "…" : ""}`;
}

// --- Tokenizer --------------------------------------------------------------
//
// A hand-rolled scanner, not a regex blacklist: it is the only way to be
// certain that comments and string literals are stripped/recognised before
// any keyword or identifier check runs, which is exactly where naive regex
// guards get smuggled past (comment-split keywords, semicolons inside a
// string literal, etc.). Every downstream check works on tokens, never on
// the raw SQL text.

type TokenType = "word" | "qident" | "string" | "number" | "param" | "qmark" | "punct";

interface Token {
  type: TokenType;
  raw: string;
  // Unicode-normalized, lowercased content for word/qident/string/param
  // tokens (quotes stripped for qident/string); raw character for punct.
  norm: string;
  start: number;
}

function normalize(text: string): string {
  return text.normalize("NFKC").toLowerCase();
}

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9_]/.test(char);
}

function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const c = sql[i]!;

    if (" \t\n\r\f\v".includes(c)) {
      i += 1;
      continue;
    }
    // Line and block comments are discarded entirely (never emitted as a
    // token), so "FROM/**/items" tokenizes as ["from", "items"] — exactly
    // as if the comment were a single space — and "SEL/**/ECT" tokenizes as
    // ["sel", "ect"], two words, neither of which is "select".
    if (c === "-" && sql[i + 1] === "-") {
      i += 2;
      while (i < n && sql[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      const close = sql.indexOf("*/", i + 2);
      i = close === -1 ? n : close + 2;
      continue;
    }
    // '...' string literal, "..."/`...` quoted identifier — all three use
    // doubling to escape their own quote char, exactly like SQLite.
    if (c === "'" || c === '"' || c === "`") {
      const quote = c;
      const start = i;
      i += 1;
      while (i < n) {
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      const raw = sql.slice(start, i);
      const inner = raw.length >= 2 ? raw.slice(1, -1).split(quote + quote).join(quote) : "";
      tokens.push({ type: quote === "'" ? "string" : "qident", raw, norm: normalize(inner), start });
      continue;
    }
    // [bracketed identifier] — SQL Server style, no internal escaping.
    if (c === "[") {
      const start = i;
      const close = sql.indexOf("]", i + 1);
      i = close === -1 ? n : close + 1;
      const raw = sql.slice(start, i);
      const inner = raw.startsWith("[") && raw.endsWith("]") ? raw.slice(1, -1) : raw.slice(1);
      tokens.push({ type: "qident", raw, norm: normalize(inner), start });
      continue;
    }
    if (c === ":") {
      const start = i;
      let j = i + 1;
      while (isWordChar(sql[j])) j += 1;
      tokens.push({ type: "param", raw: sql.slice(start, j), norm: sql.slice(start + 1, j).toLowerCase(), start });
      i = j;
      continue;
    }
    if (c === "?") {
      tokens.push({ type: "qmark", raw: "?", norm: "?", start: i });
      i += 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const start = i;
      let j = i + 1;
      while (isWordChar(sql[j])) j += 1;
      const raw = sql.slice(start, j);
      tokens.push({ type: "word", raw, norm: normalize(raw), start });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      const start = i;
      let j = i + 1;
      while (j < n && /[0-9.]/.test(sql[j]!)) j += 1;
      tokens.push({ type: "number", raw: sql.slice(start, j), norm: "", start });
      i = j;
      continue;
    }
    tokens.push({ type: "punct", raw: c, norm: c, start: i });
    i += 1;
  }
  return tokens;
}

// Distinct `:name` parameters in order of first appearance — the same order
// SQLite assigns bind indexes to named parameters, so this is exactly the
// order `.bind(...)` needs. Used both to validate declared params (guard
// time) and to build the positional bind array (execution time).
export function extractParamOrder(sql: string): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  for (const token of tokenize(sql)) {
    if (token.type === "param" && token.norm && !seen.has(token.norm)) {
      seen.add(token.norm);
      order.push(token.norm);
    }
  }
  return order;
}

export interface SqlValidation {
  sql: string; // canonical: trailing ';' stripped
  params: string[]; // distinct :param names, in first-appearance order
}

// The guard. Every rejection throws a ToolGuardError carrying a quoted
// fragment and a hint — see the module doc comment.
export function validateSql(sql: string, declaredParams: readonly string[]): SqlValidation {
  const trimmedInput = sql.trim();
  if (trimmedInput.length === 0) {
    throw guardError("SQL_EMPTY", "The SQL is empty.", "Write a single SELECT or WITH statement.");
  }
  if (sql.length > MAX_SQL_LENGTH) {
    throw guardError(
      "SQL_TOO_LONG",
      `The SQL is ${sql.length} characters; the limit is ${MAX_SQL_LENGTH}.`,
      "Shorten the statement — a user tool is one focused query, not a report.",
    );
  }

  const tokens = tokenize(sql);

  // --- exactly one statement: at most one ';', and only as the very last token
  const semicolons = tokens.filter((t) => t.type === "punct" && t.raw === ";");
  const lastToken = tokens[tokens.length - 1];
  if (semicolons.length > 1 || (semicolons.length === 1 && lastToken !== semicolons[0])) {
    const offender = semicolons.find((t) => t !== lastToken) ?? semicolons[0]!;
    throw guardError(
      "SQL_MULTIPLE_STATEMENTS",
      `Only one statement is allowed; found an extra ";" near "${fragment(sql, offender.start)}".`,
      "Remove every ';' except an optional single trailing one.",
    );
  }
  const body = semicolons.length === 1 ? tokens.slice(0, -1) : tokens;
  if (body.length === 0) {
    throw guardError("SQL_EMPTY", "The SQL is empty.", "Write a single SELECT or WITH statement.");
  }

  // --- must start with SELECT or WITH
  const first = body[0]!;
  if (first.type !== "word" || (first.norm !== "select" && first.norm !== "with")) {
    throw guardError(
      "SQL_NOT_READ_ONLY",
      `The statement must start with SELECT or WITH; found "${fragment(sql, first.start)}".`,
      "Rewrite the tool as a single SELECT (or WITH ... SELECT) statement.",
    );
  }

  // --- no anonymous positional parameters
  const qmark = body.find((t) => t.type === "qmark");
  if (qmark) {
    throw guardError(
      "SQL_POSITIONAL_PARAM",
      `Anonymous "?" parameters are not allowed, near "${fragment(sql, qmark.start)}".`,
      "Use a named parameter like :param, declared in inputSchema.",
    );
  }

  // --- forbidden bare keywords and sqlite_* identifiers, anywhere
  for (const token of body) {
    // Keywords only mean something unquoted — `SELECT 1 AS "insert"` names a
    // column "insert", it doesn't run one — so this half only looks at bare
    // words. `sqlite_*`, on the other hand, is a real table/identifier name
    // whether quoted or not, so that half also checks quoted identifiers.
    if (token.type === "word" && FORBIDDEN_KEYWORDS.has(token.norm)) {
      throw guardError(
        "SQL_FORBIDDEN_KEYWORD",
        `"${token.raw.toUpperCase()}" is not allowed, near "${fragment(sql, token.start)}".`,
        "User tools are read-only SELECTs; remove the write/schema keyword.",
      );
    }
    if ((token.type === "word" || token.type === "qident") && token.norm.startsWith("sqlite_")) {
      throw guardError(
        "SQL_FORBIDDEN_TABLE",
        `"${token.raw}" reaches SQLite's internal schema, near "${fragment(sql, token.start)}".`,
        "Query the five v_* views instead.",
      );
    }
  }

  // --- forbidden / table-valued function calls: NAME(
  for (let i = 0; i < body.length; i += 1) {
    const token = body[i]!;
    const next = body[i + 1];
    if (token.type !== "word" && token.type !== "qident") {
      continue;
    }
    if (next?.type === "punct" && next.raw === "(" && (FORBIDDEN_FUNCTIONS.has(token.norm) || token.norm.startsWith("pragma_"))) {
      throw guardError(
        "SQL_FORBIDDEN_FUNCTION",
        `"${token.raw}(...)" is not allowed, near "${fragment(sql, token.start)}".`,
        "User tools cannot load extensions or call pragma table-valued functions.",
      );
    }
  }

  // --- collect this statement's own CTE names: `name [(cols)] AS (`
  const cteNames = new Set<string>();
  for (let i = 0; i < body.length; i += 1) {
    const ident = body[i]!;
    if (ident.type !== "word" && ident.type !== "qident") {
      continue;
    }
    let j = i + 1;
    if (body[j]?.type === "punct" && body[j]?.raw === "(") {
      // Optional column-name list: `cte_name (a, b) AS (...)`. Skip to the
      // matching close paren; this is never nested, so a depth counter is
      // more machinery than the syntax needs.
      let depth = 0;
      while (j < body.length) {
        if (body[j]!.type === "punct" && body[j]!.raw === "(") depth += 1;
        if (body[j]!.type === "punct" && body[j]!.raw === ")") {
          depth -= 1;
          if (depth === 0) {
            j += 1;
            break;
          }
        }
        j += 1;
      }
    }
    if (body[j]?.type === "word" && body[j]?.norm === "as" && body[j + 1]?.type === "punct" && body[j + 1]?.raw === "(") {
      cteNames.add(ident.norm);
    }
  }

  // --- every FROM/JOIN target must be an allowed view or a CTE this statement defines
  for (let i = 0; i < body.length; i += 1) {
    const keyword = body[i]!;
    if (keyword.type !== "word" || (keyword.norm !== "from" && keyword.norm !== "join")) {
      continue;
    }
    const target = body[i + 1];
    if (!target) {
      continue;
    }
    if (target.type === "punct" && target.raw === "(") {
      continue; // subquery — its own FROM/JOINs are caught by this same loop
    }
    if (target.type !== "word" && target.type !== "qident" && target.type !== "string") {
      continue; // malformed SQL; EXPLAIN will reject it with a real syntax error
    }
    const after = body[i + 2];
    if (after?.type === "punct" && after.raw === ".") {
      throw guardError(
        "SQL_FORBIDDEN_TABLE",
        `Schema-qualified names are not allowed, near "${fragment(sql, target.start)}".`,
        "Reference v_items, v_upcoming, v_changes, v_courses or v_buckets by their bare name.",
      );
    }
    if (after?.type === "punct" && after.raw === "(") {
      throw guardError(
        "SQL_TABLE_FUNCTION",
        `Table-valued function calls are not allowed, near "${fragment(sql, target.start)}".`,
        "FROM/JOIN may only name v_items, v_upcoming, v_changes, v_courses, v_buckets or a CTE.",
      );
    }
    if (!ALLOWED_VIEW_SET.has(target.norm) && !cteNames.has(target.norm)) {
      throw guardError(
        "SQL_FORBIDDEN_TABLE",
        `"${target.raw}" is not one of the allowed views, near "${fragment(sql, target.start)}".`,
        "FROM/JOIN may only name v_items, v_upcoming, v_changes, v_courses, v_buckets or a CTE defined in this statement.",
      );
    }
  }

  // --- named parameters: every :param must be declared in inputSchema
  const declared = new Set(declaredParams);
  const seen = new Set<string>();
  const params: string[] = [];
  for (const token of body) {
    if (token.type !== "param") {
      continue;
    }
    if (!token.norm) {
      throw guardError("SQL_INVALID_PARAM", `":" must be followed by a parameter name, near "${fragment(sql, token.start)}".`, "Write :paramName.");
    }
    if (!declared.has(token.norm)) {
      throw guardError(
        "SQL_UNKNOWN_PARAM",
        `":${token.norm}" is not declared in inputSchema, near "${fragment(sql, token.start)}".`,
        `Add "${token.norm}" to inputSchema, or fix the typo in the SQL.`,
      );
    }
    if (!seen.has(token.norm)) {
      seen.add(token.norm);
      params.push(token.norm);
    }
  }

  const canonicalEnd = semicolons.length === 1 ? semicolons[0]!.start : sql.length;
  return { sql: sql.slice(0, canonicalEnd).trim(), params };
}

export function wrapSql(sql: string): string {
  return `SELECT * FROM (${sql}) LIMIT ${RESULT_ROW_LIMIT}`;
}

// --- Non-SQL guards ---------------------------------------------------------

export function validateToolName(name: string, reserved: ReadonlySet<string> = RESERVED_DOOR_TOOL_NAMES): void {
  if (!TOOL_NAME_PATTERN.test(name)) {
    throw guardError(
      "TOOL_INVALID_NAME",
      `"${name}" is not a valid tool name.`,
      "Use lowercase letters, digits and underscores, starting with a letter, 3-40 characters (e.g. next_lab).",
    );
  }
  if (reserved.has(name)) {
    throw guardError("TOOL_NAME_RESERVED", `"${name}" collides with a built-in door tool.`, "Choose a name that isn't one of the door's built-in tools.");
  }
}

export function validateDescription(description: string): void {
  if (description.trim().length === 0) {
    throw guardError("TOOL_DESCRIPTION_EMPTY", "description is empty.", "Describe what the tool returns, in one sentence.");
  }
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    throw guardError(
      "TOOL_DESCRIPTION_TOO_LONG",
      `description is ${description.length} characters; the limit is ${MAX_DESCRIPTION_LENGTH}.`,
      `Shorten it to ${MAX_DESCRIPTION_LENGTH} characters or fewer.`,
    );
  }
}

const PARAM_TYPES = new Set<UserToolParamType>(["string", "number", "integer", "boolean"]);

// Returns the declared param names, for validateSql to check :param usages against.
export function validateInputSchema(schema: UserToolInputSchema): string[] {
  const names = Object.keys(schema);
  if (names.length > MAX_PARAMS) {
    throw guardError(
      "TOOL_TOO_MANY_PARAMS",
      `inputSchema declares ${names.length} params; the limit is ${MAX_PARAMS}.`,
      "Fold related inputs together or split this into two tools.",
    );
  }
  for (const name of names) {
    if (!PARAM_NAME_PATTERN.test(name)) {
      throw guardError(
        "TOOL_INVALID_PARAM_NAME",
        `Param "${name}" is not a valid name.`,
        "Use lowercase letters, digits and underscores, starting with a letter.",
      );
    }
    const param = schema[name]!;
    if (!PARAM_TYPES.has(param.type)) {
      throw guardError(
        "TOOL_INVALID_PARAM_TYPE",
        `Param "${name}" has type "${String(param.type)}".`,
        'Use one of "string", "number", "integer", "boolean".',
      );
    }
    if (param.description !== undefined && param.description.length > MAX_DESCRIPTION_LENGTH) {
      throw guardError(
        "TOOL_DESCRIPTION_TOO_LONG",
        `Param "${name}"'s description is too long.`,
        `Keep it under ${MAX_DESCRIPTION_LENGTH} characters.`,
      );
    }
  }
  return names;
}

// --- zod conversion ----------------------------------------------------------

function literalUnion(values: Array<string | number>): z.ZodTypeAny {
  const literals: z.ZodTypeAny[] = values.map((value) => z.literal(value));
  return literals.length === 1 ? literals[0]! : z.union(literals);
}

// Converts a stored inputSchema into the zod raw shape `registerTool` wants.
export function buildZodInputSchema(schema: UserToolInputSchema): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [name, param] of Object.entries(schema)) {
    let field: z.ZodTypeAny;
    if (param.enum && param.enum.length > 0) {
      field = literalUnion(param.enum);
    } else if (param.type === "string") {
      field = z.string();
    } else if (param.type === "boolean") {
      field = z.boolean();
    } else if (param.type === "integer") {
      field = z.number().int();
    } else {
      field = z.number();
    }
    if (param.description) {
      field = field.describe(param.description);
    }
    shape[name] = param.default === undefined ? field : field.optional().default(param.default as never);
  }
  return shape;
}

// Placeholder bind values for the definition-time EXPLAIN — never executed,
// just needs to type-check against the statement's parameter slots.
function dummyParamValues(schema: UserToolInputSchema, paramOrder: readonly string[]): unknown[] {
  return paramOrder.map((name) => {
    const type = schema[name]?.type;
    if (type === "string") return "";
    if (type === "boolean") return 0;
    return 0; // number | integer
  });
}

// --- Store -------------------------------------------------------------------

interface UserToolRow {
  name: string;
  description: string;
  input_schema_json: string;
  sql: string;
  created_at: string;
  updated_at: string;
}

function parseRow(row: UserToolRow): UserToolDefinition {
  return {
    name: row.name,
    description: row.description,
    inputSchema: JSON.parse(row.input_schema_json) as UserToolInputSchema,
    sql: row.sql,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface UserToolStore {
  list(): Promise<UserToolDefinition[]>;
  get(name: string): Promise<UserToolDefinition | null>;
  define(input: DefineToolInput, reserved?: ReadonlySet<string>): Promise<UserToolDefinition>;
  delete(name: string): Promise<boolean>;
}

export class D1UserToolStore implements UserToolStore {
  constructor(
    private readonly db: D1Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async list(): Promise<UserToolDefinition[]> {
    const rows = await this.db.prepare("SELECT * FROM user_tools ORDER BY name").all<UserToolRow>();
    return rows.results.map(parseRow);
  }

  async get(name: string): Promise<UserToolDefinition | null> {
    const row = await this.db.prepare("SELECT * FROM user_tools WHERE name = ?").bind(name).first<UserToolRow>();
    return row ? parseRow(row) : null;
  }

  async delete(name: string): Promise<boolean> {
    const result = await this.db.prepare("DELETE FROM user_tools WHERE name = ?").bind(name).run();
    return result.meta.changes > 0;
  }

  // Runs every mechanical guard, then proves the wrapped SQL against the
  // real schema with EXPLAIN before ever storing it — a tool that fails to
  // define never becomes a tool that fails at call time.
  async define(input: DefineToolInput, reserved: ReadonlySet<string> = RESERVED_DOOR_TOOL_NAMES): Promise<UserToolDefinition> {
    validateToolName(input.name, reserved);
    validateDescription(input.description);
    const declaredParams = validateInputSchema(input.inputSchema);
    const { sql, params } = validateSql(input.sql, declaredParams);

    const existing = await this.get(input.name);
    if (!existing) {
      const { n } = (await this.db.prepare("SELECT COUNT(*) AS n FROM user_tools").first<{ n: number }>()) ?? { n: 0 };
      if (n >= MAX_TOOLS) {
        throw guardError("TOOL_CAP_REACHED", `Already at the cap of ${MAX_TOOLS} tools.`, "Delete an unused tool with delete_tool before defining a new one.");
      }
    }

    const wrapped = wrapSql(sql);
    try {
      await this.db
        .prepare(`EXPLAIN ${wrapped}`)
        .bind(...dummyParamValues(input.inputSchema, params))
        .all();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw guardError(
        "SQL_EXPLAIN_FAILED",
        `SQLite rejected the statement: ${message}. Near "${fragment(sql, 0, 80)}".`,
        "Fix the SQL so it parses and references only real columns of the five v_* views, then define the tool again.",
      );
    }

    const nowIso = this.now().toISOString();
    const createdAt = existing?.createdAt ?? nowIso;
    await this.db
      .prepare(
        `INSERT INTO user_tools (name, description, input_schema_json, sql, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (name) DO UPDATE SET
           description = excluded.description,
           input_schema_json = excluded.input_schema_json,
           sql = excluded.sql,
           updated_at = excluded.updated_at`,
      )
      .bind(input.name, input.description, JSON.stringify(input.inputSchema), sql, createdAt, nowIso)
      .run();

    return { name: input.name, description: input.description, inputSchema: input.inputSchema, sql, createdAt, updatedAt: nowIso };
  }
}

// --- Execution + rendering ----------------------------------------------------

export interface RenderedRows {
  text: string;
  rows: Array<Record<string, unknown>>;
  truncated: boolean;
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.replace(/\|/g, "\\|").replace(/\s+/g, " ").slice(0, 200);
}

// Model-friendly rendering: a compact pipe table, an explicit row count, an
// explicit truncation note (and why), and a `Next:` hint when there is one —
// so a client model can decide whether to narrow the query without another
// round trip just to ask "was that everything?".
export function renderRows(rows: Array<Record<string, unknown>>): RenderedRows {
  if (rows.length === 0) {
    return { text: "(0 rows)\nNext: no rows matched — check the WHERE clause or the bound values.", rows: [], truncated: false };
  }

  const hitRowCap = rows.length >= RESULT_ROW_LIMIT;
  const columns = Object.keys(rows[0]!);
  const header = `| ${columns.join(" | ")} |`;
  const separator = `| ${columns.map(() => "---").join(" | ")} |`;
  const lines: string[] = [];
  let bytes = header.length + separator.length + 2;
  let sizeTruncated = false;
  for (const row of rows) {
    const line = `| ${columns.map((column) => formatCell(row[column])).join(" | ")} |`;
    if (bytes + line.length > RESULT_TEXT_BUDGET_BYTES) {
      sizeTruncated = true;
      break;
    }
    lines.push(line);
    bytes += line.length + 1;
  }

  const truncated = hitRowCap || sizeTruncated;
  const reasons = [hitRowCap ? "at 200 rows" : null, sizeTruncated ? "at ~50KB of output" : null].filter((reason): reason is string => reason !== null);
  const summary = `${lines.length} row${lines.length === 1 ? "" : "s"}${truncated ? ` (truncated ${reasons.join(", ")})` : ""}`;
  const next = truncated ? "\nNext: narrow the query (add a WHERE clause or a smaller window) to see the rest." : "";

  return {
    text: `${[header, separator, ...lines].join("\n")}\n\n${summary}${next}`,
    rows: rows.slice(0, lines.length),
    truncated,
  };
}

export interface ToolCallErrorResult {
  // Index signature to match the MCP SDK's CallToolResult shape structurally
  // (it's an open record), so this can be returned directly from a tool
  // handler alongside the success-shaped object literal in the same branch.
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError: true;
}

export function toolErrorResult(error: unknown, fallbackCode = "TOOL_ERROR"): ToolCallErrorResult {
  const toolError: ToolError =
    error instanceof ToolGuardError
      ? error.toolError
      : { code: fallbackCode, message: error instanceof Error ? error.message : String(error), hint: "Check the tool's SQL and try again." };
  return { content: [{ type: "text", text: JSON.stringify({ error: toolError }) }], isError: true };
}

async function executeUserTool(db: D1Database, tool: UserToolDefinition, args: Record<string, unknown>): Promise<Array<Record<string, unknown>>> {
  const order = extractParamOrder(tool.sql);
  const values = order.map((name) => args[name] ?? null);
  const result = await db
    .prepare(wrapSql(tool.sql))
    .bind(...values)
    .all<Record<string, unknown>>();
  return result.results;
}

// --- Door registration ---------------------------------------------------

export interface RegisterUserToolsDeps {
  db: D1Database;
}

// ADR-0035 §7/§9: mounts every currently-defined user tool on the door. The
// door has no long-lived process — a fresh McpServer is built per request
// (see src/index.ts) — so "dynamic" here just means "re-read user_tools on
// every construction"; there is no live connection to send a
// tools/list_changed notification to, and no listChanged capability to
// declare beyond what registerTool already advertises for every door tool.
export async function registerUserTools(server: McpServer, deps: RegisterUserToolsDeps): Promise<void> {
  const tools = await new D1UserToolStore(deps.db).list();
  for (const tool of tools) {
    if (RESERVED_DOOR_TOOL_NAMES.has(tool.name)) {
      continue; // defensive: define_tool already refuses this name at write time
    }
    server.registerTool(
      tool.name,
      {
        annotations: READ_ONLY,
        description: tool.description,
        inputSchema: buildZodInputSchema(tool.inputSchema),
      },
      async (args: Record<string, unknown>) => {
        try {
          const rows = await executeUserTool(deps.db, tool, args);
          const { text, rows: keptRows, truncated } = renderRows(rows);
          return { content: [{ type: "text" as const, text }], structuredContent: { rows: keptRows, truncated } };
        } catch (error) {
          return toolErrorResult(error, "TOOL_EXECUTION_FAILED");
        }
      },
    );
  }
}
