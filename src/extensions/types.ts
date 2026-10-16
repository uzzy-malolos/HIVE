export interface ExtensionOptions {
  /** Runtime trust state; tests can isolate it without changing the user's home. */
  trustStateDir?: string;
  /** Encrypted OAuth state; defaults outside the repository. */
  authStateDir?: string;
  /** OS-backed cipher override for an embedding host or isolated tests. */
  authCipher?: OAuthCipher;
  /** Test/development only: permit literal loopback HTTP authorization endpoints. */
  allowLoopbackOAuthHttp?: boolean;
  /** Explicit embedding/development opt-in for private HTTPS OAuth infrastructure. */
  allowPrivateOAuthHosts?: boolean;
  /** Trusted host capability callbacks; never read from repository configuration. */
  mcpHost?: (serverId: string) => import("./mcp.js").McpIncomingHandler;
  /** Approved model/tool execution for Claude hook handlers, supplied only by the host. */
  claudeHookHost?: import("./claude-hooks.js").ClaudeHookHost;
}

export interface OAuthCipher {
  readonly kind: string;
  encrypt(plaintext: Uint8Array): Promise<Uint8Array>;
  decrypt(ciphertext: Uint8Array): Promise<Uint8Array>;
}

export interface McpOAuthConfig {
  clientId?: string;
  clientSecretEnv?: string;
  scopes?: string[];
  /** A pre-registered fixed loopback port; otherwise an ephemeral port is used. */
  redirectPort?: number;
}

export interface ExtensionState {
  id: string;
  enabled: boolean;
  trusted: boolean;
  fingerprint: string;
  pluginId?: string;
  /** Unmet plugin dependency policy; saved trust/enable choices remain intact. */
  blockedReason?: string;
}

export interface ProcessSpec {
  command: string;
  args: string[];
  cwd: string;
  envRefs: Record<string, string>;
  /** Explicit non-secret configuration values; credentials remain envRefs. */
  env?: Record<string, string>;
  timeoutMs: number;
}

export type McpServerDescriptor = ExtensionState & { name: string } & (
  | { transport: "stdio"; process: ProcessSpec }
  | { transport: "http"; url: string; bearerTokenEnv?: string; oauth?: McpOAuthConfig; timeoutMs: number }
);

export interface SkillDescriptor extends ExtensionState {
  name: string;
  path: string;
  description: string;
}

export type HookEvent = "session_start" | "prompt_submit" | "before_tool" | "after_tool" | "after_tool_failure" | "session_end" | "stop" | "stop_failure" | "subagent_start" | "subagent_stop" | "permission_request";
export interface HookDescriptor extends ExtensionState {
  event: HookEvent;
  process?: ProcessSpec;
  timeoutMs?: number;
  claude?: import("./claude-hooks.js").ClaudeHookConfiguration;
}

export interface PluginDescriptor extends ExtensionState {
  name: string;
  path: string;
  description: string;
  sourceName?: string;
  marketplace?: string;
  pluginVersion?: string;
  dependencies?: import("./plugin-components.js").PluginDependency[];
}

export interface ExtensionCatalog {
  root: string;
  configPath: string;
  servers: McpServerDescriptor[];
  skills: SkillDescriptor[];
  hooks: HookDescriptor[];
  plugins: PluginDescriptor[];
  agents: import("./plugin-agents.js").PluginAgentDescriptor[];
  lspServers: import("./lsp-config.js").LspServerDescriptor[];
  outputStyles: import("./plugin-output-styles.js").PluginOutputStyleDescriptor[];
  diagnostics: string[];
}

export interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Trusted host preflight, invoked synchronously just before a transport sends. */
  beforeSend?: () => void;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execution?: { taskSupport: "required" | "optional" | "forbidden" };
}

export interface McpToolResult {
  content: Array<Record<string, unknown>>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}
export type McpToolCallResult = McpToolResult | { task: McpTaskHandle };

export interface McpConnection {
  serverId: string;
  protocolVersion: string;
  capabilities: McpCapabilities;
  listTools(options?: RequestOptions): Promise<McpTool[]>;
  callTool(name: string, args: Record<string, unknown>, options?: RequestOptions): Promise<McpToolCallResult>;
  listResources(options?: RequestOptions): Promise<McpResource[]>;
  listResourceTemplates(options?: RequestOptions): Promise<McpResourceTemplate[]>;
  readResource(uri: string, options?: RequestOptions): Promise<McpResourceResult>;
  listPrompts(options?: RequestOptions): Promise<McpPrompt[]>;
  getPrompt(name: string, args?: Record<string, string>, options?: RequestOptions): Promise<McpPromptResult>;
  complete(reference: McpCompletionReference, argument: { name: string; value: string }, options?: McpCompletionOptions): Promise<McpCompletionResult>;
  onListChanged(listener: (kind: McpListKind) => void): () => void;
  startBackground(options?: RequestOptions): Promise<void>;
  stopBackground(): Promise<void>;
  onBackgroundError(listener: (error: Error) => void): () => void;
  subscribeResource(uri: string, options?: RequestOptions): Promise<void>;
  unsubscribeResource(uri: string, options?: RequestOptions): Promise<void>;
  onResourceUpdated(listener: (uri: string) => void): () => void;
  callToolTask(name: string, args: Record<string, unknown>, options?: RequestOptions & { ttl?: number }): Promise<McpToolCallResult>;
  getTask(taskId: string, options?: RequestOptions): Promise<McpTask>;
  listTasks(options?: RequestOptions & { cursor?: string }): Promise<McpTaskList>;
  getTaskResult(taskId: string, options?: RequestOptions): Promise<McpToolResult>;
  cancelTask(taskId: string, options?: RequestOptions): Promise<McpTask | { taskId: string; cancellationRequested: true }>;
  updateTask(taskId: string, options?: RequestOptions): Promise<{ taskId: string; updatedInputKeys: string[] }>;
  subscribeTask(taskId: string, options?: RequestOptions): Promise<void>;
  unsubscribeTask(taskId: string, options?: RequestOptions): Promise<void>;
  onTaskStatus(listener: (task: McpTask) => void): () => void;
  close(): Promise<void>;
}

export interface HookResult {
  id: string;
  ok: boolean;
  output: string;
  exitCode: number | null;
  blocked?: boolean;
  stop?: boolean;
  /** Stop/SubagentStop asks the current bounded loop to continue with this feedback. */
  continuation?: string;
  additionalContext?: string;
  diagnostics?: string[];
}
import type {
  McpCapabilities, McpCompletionOptions, McpCompletionReference, McpCompletionResult,
  McpListKind, McpPrompt, McpPromptResult, McpResource, McpResourceResult, McpResourceTemplate,
} from "./mcp-advanced.js";
export type * from "./mcp-advanced.js";
import type { McpTask, McpTaskHandle, McpTaskList } from "./mcp-tasks.js";
export type * from "./mcp-tasks.js";

