export const BUILTIN_AGENT_TOOL_NAMES = [
  "read_file", "list_directory", "search_text", "search_symbols", "create_file",
  "write_file", "edit_file", "apply_patch", "inspect_diff", "run_command", "run_test", "read_command_output",
] as const;
export type BuiltinAgentToolName = (typeof BUILTIN_AGENT_TOOL_NAMES)[number];
export type AgentToolName = BuiltinAgentToolName | "read_skill_reference" | `mcp__${string}__${string}` | `mcp_context__${string}__${string}` | `lsp__${string}__${string}`;

export interface AgentToolDefinition {
  name: AgentToolName;
  description: string;
  inputSchema: Record<string, unknown>;
}

const relativePath = { type: "string", minLength: 1, description: "Repository-relative path inside the assigned workspace." };
const nonemptyString = { type: "string", minLength: 1 };
const searchProperties = {
  query: nonemptyString,
  paths: { type: "array", items: relativePath, description: "Files or directories to search; defaults to the repository root." },
  caseSensitive: { type: "boolean", default: false },
  maxResults: { type: "number", description: "Result limit, clamped to 1 through 2000; defaults to 200." },
};
const commandProperties = {
  command: { oneOf: [{ type: "string", minLength: 1 }, { type: "array", items: nonemptyString, minItems: 1 }], description: "Approved executable and arguments. Prefer an argument array; shell operators and external operations are prohibited." },
  cwd: { ...relativePath, description: "Working directory inside the repository; defaults to the repository root." },
  timeoutMs: { type: "number", description: "Command timeout in milliseconds, subject to runtime limits." },
};

// These schemas describe RepositoryToolService.execute; execution still enforces scope and approval policy.
const builtinDefinitions = {
  read_file: {
    description: "Read a UTF-8 file in the repository.",
    inputSchema: { type: "object", properties: { path: relativePath, maxChars: { type: "number", description: "Maximum characters to read." } }, required: ["path"], additionalProperties: false },
  },
  list_directory: {
    description: "List immediate entries in a repository directory.",
    inputSchema: { type: "object", properties: { path: { ...relativePath, default: "." } }, additionalProperties: false },
  },
  search_text: {
    description: "Search repository text, returning matching paths, lines, and columns.",
    inputSchema: { type: "object", properties: { ...searchProperties, regex: { type: "boolean", default: false } }, required: ["query"], additionalProperties: false },
  },
  search_symbols: {
    description: "Find TypeScript or JavaScript declarations whose names contain the query.",
    inputSchema: { type: "object", properties: searchProperties, required: ["query"], additionalProperties: false },
  },
  create_file: {
    description: "Create a new UTF-8 file with the supplied content. Fails if the file already exists. Writes must stay inside the assigned file scope.",
    inputSchema: { type: "object", properties: { path: relativePath, content: nonemptyString }, required: ["path", "content"], additionalProperties: false },
  },
  write_file: {
    description: "Create or replace a UTF-8 file with the supplied complete content. Writes must stay inside the assigned file scope.",
    inputSchema: { type: "object", properties: { path: relativePath, content: nonemptyString }, required: ["path", "content"], additionalProperties: false },
  },
  edit_file: {
    description: "Replace exact matching text in an existing UTF-8 file. By default search must match exactly once; replaceAll allows multiple matches. Writes must stay inside the assigned file scope.",
    inputSchema: { type: "object", properties: { path: relativePath, search: nonemptyString, replacement: { type: "string", default: "" }, replaceAll: { type: "boolean", default: false } }, required: ["path", "search"], additionalProperties: false },
  },
  apply_patch: {
    description: "Apply a unified Git text diff with repository-relative file paths. Supply diff --git, ---/+++ headers and @@ hunks; binary, symbolic-link, and submodule patches are unsupported. All changed files must be inside the assigned file scope.",
    inputSchema: { type: "object", properties: { patch: nonemptyString }, required: ["patch"], additionalProperties: false },
  },
  inspect_diff: {
    description: "Inspect the repository's unstaged Git diff without changing files.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  run_command: {
    description: "Run an approved repository inspection, build, or check command under the active approval policy.",
    inputSchema: { type: "object", properties: commandProperties, required: ["command"], additionalProperties: false },
  },
  run_test: {
    description: "Run an approved test or validation command under the active approval policy.",
    inputSchema: { type: "object", properties: commandProperties, required: ["command"], additionalProperties: false },
  },
  read_command_output: {
    description: "Read the saved output of a previous command using its returned commandId.",
    inputSchema: { type: "object", properties: { commandId: nonemptyString, maxChars: { type: "number", description: "Maximum characters to read." } }, required: ["commandId"], additionalProperties: false },
  },
} satisfies Record<BuiltinAgentToolName, Omit<AgentToolDefinition, "name">>;

export const BUILTIN_AGENT_TOOL_DEFINITIONS: readonly AgentToolDefinition[] = BUILTIN_AGENT_TOOL_NAMES.map((name) => ({ name, ...builtinDefinitions[name] }));
