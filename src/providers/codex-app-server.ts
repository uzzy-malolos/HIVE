import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { lstat, mkdtemp, mkdir, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import type { ProviderCompletionInput, ProviderCompletionResult } from './types.js';
import { validateProviderImages } from './images.js';
import { outputTokenLimit } from './limits.js';

/** Trusted host configuration only. Never populate this from a plugin or repository file. */
export interface CodexAppServerOptions {
  executable?: string;
  args?: readonly string[];
  homeDir?: string;
  requestTimeoutMs?: number;
  signal?: AbortSignal;
}

export type ChatGptLogin =
  | { type: 'browser'; loginId: string; authUrl: string }
  | { type: 'device'; loginId: string; verificationUrl: string; userCode: string };

export interface ChatGptAccountStatus {
  authenticated: boolean;
  authMode: 'chatgpt' | 'apiKey' | 'other' | null;
  planType?: string;
}

export interface ChatGptModel {
  id: string;
  model: string;
  displayName: string;
  supportedReasoningEfforts: string[];
  defaultReasoningEffort?: string;
  serviceTiers: string[];
  defaultServiceTier?: string;
}

type JsonRecord = Record<string, unknown>;
type Notification = { method: string; params: JsonRecord };
type PendingRequest = { resolve: (value: unknown) => void; reject: (error: Error) => void; cleanup: () => void };
const MAX_LINE_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

function record(value: unknown, context: string): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`Invalid Codex ${context}.`);
  return value as JsonRecord;
}

function requiredString(value: unknown, context: string): string {
  if (typeof value !== 'string' || !value || value.length > 65_536 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)) throw new Error(`Invalid Codex ${context}.`);
  return value;
}

function authUrl(value: unknown): string {
  const text = requiredString(value, 'sign-in URL');
  let parsed: URL;
  try { parsed = new URL(text); } catch { throw new Error('Invalid Codex sign-in URL.'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password ||
      !['auth.openai.com', 'chatgpt.com'].includes(parsed.hostname)) throw new Error('Codex sign-in URL is not an official HTTPS sign-in endpoint.');
  return text;
}

function childEnvironment(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  // Do not import API credentials, another client's CODEX_HOME, or its config overrides.
  const allowed = /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMDATA|SYSTEMDRIVE|HTTPS?_PROXY|ALL_PROXY|NO_PROXY|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR|LANG|LC_ALL)$/i;
  for (const [key, value] of Object.entries(process.env)) if (allowed.test(key) && value !== undefined) env[key] = value;
  env.CODEX_HOME = home;
  return env;
}

// All overrides apply only to this child. Codex owns its login/token lifecycle and OS keyring.
const CHILD_CONFIG = [
  'cli_auth_credentials_store="keyring"', 'forced_login_method="chatgpt"',
  'project_doc_max_bytes=0', 'web_search="disabled"', 'apps._default.enabled=false',
  'skills.include_instructions=false', 'skills.bundled.enabled=false',
  'agents.enabled=false', 'features.shell_tool=false', 'features.unified_exec=false',
  'features.code_mode=false', 'features.code_mode_host=false', 'features.code_mode_only=false',
  'features.js_repl=false', 'features.multi_agent=false', 'features.multi_agent_v2=false',
  'features.memories=false', 'features.memory_tool=false', 'features.apps=false',
  'features.browser_use=false', 'features.computer_use=false', 'features.hooks=false',
  'features.codex_hooks=false', 'features.plugins=false', 'features.skills=false',
  'features.view_image=false', 'features.request_permissions_tool=false',
  'features.tool_suggest=false', 'features.tool_search=false', 'features.sleep_tool=false',
  'features.current_time_reminder=false', 'features.token_budget=false',
  'features.image_generation=false', 'features.deferred_executor=false',
  'features.send_message_to_user_async=false',
  'tools.update_plan.enabled=false', 'tools.experimental_request_user_input.enabled=false',
];

/** Narrow stdio client for the installed, supported Codex app-server protocol. */
export class CodexAppServer {
  private readonly pending = new Map<number, PendingRequest>();
  private readonly listeners = new Set<(notification: Notification) => void>();
  private readonly loginResults = new Map<string, { success: boolean; error?: string }>();
  private nextId = 1;
  private buffer = '';
  private closed = false;
  private failure?: Error;

  constructor(private readonly child: ChildProcessWithoutNullStreams, private readonly cwd: string, private readonly requestTimeoutMs: number) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (data: string) => this.receive(data));
    child.stdin.on('error', () => this.fail(new Error('Codex app-server input failed.')));
    child.stdout.on('error', () => this.fail(new Error('Codex app-server output failed.')));
    // Do not forward stderr: provider diagnostics may contain account information.
    child.stderr.resume();
    child.on('error', () => this.fail(new Error('Could not launch Codex app-server. Install Codex and ensure its executable is on PATH.')));
    child.on('exit', (code) => this.fail(new Error(`Codex app-server exited${code === null ? '' : ` (${code})`}.`)));
  }

  private fail(error: Error): void {
    if (!this.failure) this.failure = error;
    for (const pending of this.pending.values()) { pending.cleanup(); pending.reject(error); }
    this.pending.clear();
    for (const listener of this.listeners) listener({ method: 'hive/closed', params: {} });
    this.listeners.clear();
    if (!this.child.killed) this.child.kill();
  }

  private write(value: unknown): void {
    if (this.closed || this.failure) throw this.failure ?? new Error('Codex app-server is closed.');
    this.child.stdin.write(`${JSON.stringify(value)}\n`, (error) => { if (error) this.fail(new Error('Codex app-server input failed.')); });
  }

  private receive(data: string): void {
    this.buffer += data;
    if (Buffer.byteLength(this.buffer) > MAX_LINE_BYTES && !this.buffer.includes('\n')) return this.fail(new Error('Codex app-server response exceeded its size limit.'));
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) return this.fail(new Error('Codex app-server response exceeded its size limit.'));
      try {
        const message = record(JSON.parse(line), 'RPC message');
        if (typeof message.method === 'string') {
          if (message.id !== undefined) { this.rejectServerRequest(message); continue; }
          const notification = { method: message.method, params: record(message.params ?? {}, 'notification parameters') };
          if (notification.method === 'account/login/completed') {
            const id = requiredString(notification.params.loginId, 'login ID');
            if (typeof notification.params.success !== 'boolean') throw new Error('Invalid Codex sign-in completion.');
            if (this.loginResults.size >= 16) this.loginResults.delete(this.loginResults.keys().next().value ?? '');
            this.loginResults.set(id, { success: notification.params.success, ...(!notification.params.success ? { error: 'ChatGPT sign-in did not complete. Retry sign-in in HIVE.' } : {}) });
          }
          for (const listener of this.listeners) listener(notification);
        } else if (typeof message.id === 'number') {
          const pending = this.pending.get(message.id);
          if (!pending) continue;
          this.pending.delete(message.id); pending.cleanup();
          if (message.error !== undefined) pending.reject(new Error('Codex app-server rejected the request. Check that the installed Codex version supports this operation.'));
          else if ('result' in message) pending.resolve(message.result);
          else pending.reject(new Error('Invalid Codex RPC response.'));
        } else throw new Error('Invalid Codex RPC message.');
      } catch (error) { return this.fail(error instanceof Error ? error : new Error('Invalid Codex app-server response.')); }
    }
  }

  private rejectServerRequest(message: JsonRecord): void {
    const method = message.method;
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
      this.write({ id: message.id, result: { decision: 'decline' } });
    } else if (method === 'execCommandApproval' || method === 'applyPatchApproval') {
      this.write({ id: message.id, result: { decision: 'denied' } });
    } else if (method === 'item/tool/call') {
      this.write({ id: message.id, result: { success: false, contentItems: [{ type: 'inputText', text: 'HIVE does not delegate tool execution to Codex.' }] } });
    } else {
      this.write({ id: message.id, error: { code: -32601, message: 'HIVE does not expose this capability.' } });
    }
    for (const listener of this.listeners) listener({ method: 'hive/toolRejected', params: {} });
  }

  private request(method: string, params?: unknown, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    if (this.failure || this.closed) return Promise.reject(this.failure ?? new Error('Codex app-server is closed.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const abort = () => { this.pending.delete(id); cleanup(); reject(signal?.reason instanceof Error ? signal.reason : new Error('Codex request aborted.')); };
      const timer = setTimeout(() => { this.pending.delete(id); cleanup(); reject(new Error(`Codex ${method} timed out.`)); }, this.requestTimeoutMs);
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
      this.pending.set(id, { resolve, reject, cleanup });
      signal?.addEventListener('abort', abort, { once: true });
      try { this.write({ id, method, ...(params !== undefined ? { params } : {}) }); }
      catch (error) { this.pending.delete(id); cleanup(); reject(error); }
    });
  }

  async initialize(signal?: AbortSignal): Promise<void> {
    await this.request('initialize', { clientInfo: { name: 'hive_cli', title: 'HIVE CLI', version: '0.6.0' }, capabilities: { experimentalApi: true, requestAttestation: false, explicitGatewayOauth: true } }, signal);
    this.write({ method: 'initialized' });
  }

  async accountStatus(signal?: AbortSignal): Promise<ChatGptAccountStatus> {
    const response = record(await this.request('account/read', { refreshToken: false }, signal), 'account response');
    if (response.account === null) return { authenticated: false, authMode: null };
    const account = record(response.account, 'account');
    if (account.type === 'chatgpt') return { authenticated: true, authMode: 'chatgpt', ...(typeof account.planType === 'string' ? { planType: account.planType } : {}) };
    return { authenticated: false, authMode: account.type === 'apiKey' ? 'apiKey' : 'other' };
  }

  async startLogin(options: { method: 'browser' | 'device' }, signal?: AbortSignal): Promise<ChatGptLogin> {
    const response = record(await this.request('account/login/start', options.method === 'device' ? { type: 'chatgptDeviceCode' } : { type: 'chatgpt', useHostedLoginSuccessPage: true, appBrand: 'codex' }, signal), 'login response');
    const loginId = requiredString(response.loginId, 'login ID');
    if (response.type === 'chatgpt') return { type: 'browser', loginId, authUrl: authUrl(response.authUrl) };
    if (response.type === 'chatgptDeviceCode') return { type: 'device', loginId, verificationUrl: authUrl(response.verificationUrl), userCode: requiredString(response.userCode, 'device code') };
    throw new Error('Codex returned an unsupported sign-in method.');
  }

  async waitForLogin(loginId: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<{ success: boolean; error?: string }> {
    requiredString(loginId, 'login ID');
    options.signal?.throwIfAborted();
    if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 900_000)) throw new Error('Invalid ChatGPT sign-in timeout.');
    if (this.failure || this.closed) throw this.failure ?? new Error('Codex app-server is closed.');
    const known = this.loginResults.get(loginId);
    if (known) return known;
    return new Promise((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer); this.listeners.delete(listener); options.signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(this.loginResults.get(loginId) ?? { success: false, error: 'ChatGPT sign-in did not complete.' });
      };
      const abort = () => { void this.cancelLogin(loginId).catch(() => {}); finish(options.signal?.reason instanceof Error ? options.signal.reason : new Error('ChatGPT sign-in aborted.')); };
      const listener = (notification: Notification) => {
        if (notification.method === 'hive/closed') finish(this.failure ?? new Error('Codex app-server closed during sign-in.'));
        else if (notification.method === 'account/login/completed' && notification.params.loginId === loginId) finish();
      };
      const timeout = options.timeoutMs ?? 300_000;
      const timer = setTimeout(() => { void this.cancelLogin(loginId).catch(() => {}); finish(new Error('ChatGPT sign-in timed out.')); }, timeout);
      this.listeners.add(listener); options.signal?.addEventListener('abort', abort, { once: true });
    });
  }

  async cancelLogin(loginId: string): Promise<void> { await this.request('account/login/cancel', { loginId: requiredString(loginId, 'login ID') }); }
  async logout(signal?: AbortSignal): Promise<void> { await this.request('account/logout', undefined, signal); }

  async listModels(signal?: AbortSignal): Promise<ChatGptModel[]> {
    const models: ChatGptModel[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const response = record(await this.request('model/list', { limit: 50, includeHidden: false, ...(cursor ? { cursor } : {}) }, signal), 'model list');
      if (!Array.isArray(response.data) || response.data.length > 50) throw new Error('Invalid Codex model list.');
      for (const raw of response.data) {
        const model = record(raw, 'model');
        const efforts = Array.isArray(model.supportedReasoningEfforts) ? model.supportedReasoningEfforts : [];
        const tiers = Array.isArray(model.serviceTiers) ? model.serviceTiers : [];
        models.push({ id: requiredString(model.id, 'model ID'), model: requiredString(model.model, 'model name'), displayName: requiredString(model.displayName, 'model display name'),
          supportedReasoningEfforts: efforts.map((value) => requiredString(record(value, 'reasoning effort').reasoningEffort, 'reasoning effort')),
          serviceTiers: tiers.map((value) => requiredString(record(value, 'service tier').id, 'service tier ID')),
          ...(typeof model.defaultReasoningEffort === 'string' ? { defaultReasoningEffort: model.defaultReasoningEffort } : {}),
          ...(typeof model.defaultServiceTier === 'string' ? { defaultServiceTier: model.defaultServiceTier } : {}),
        });
      }
      if (response.nextCursor === null || response.nextCursor === undefined) return models;
      cursor = requiredString(response.nextCursor, 'model cursor');
      if (cursors.has(cursor)) throw new Error('Codex model list repeated a pagination cursor.');
      cursors.add(cursor);
    }
    throw new Error('Codex model list exceeded 500 models.');
  }

  async complete(input: ProviderCompletionInput, onChunk?: (chunk: string) => void): Promise<ProviderCompletionResult> {
    outputTokenLimit(input.maxOutputTokens);
    if (input.maxOutputTokens !== undefined) throw new Error('ChatGPT subscription via this Codex app-server cannot enforce maxOutputTokens. Choose a provider with request token limits for this operation.');
    input.signal?.throwIfAborted();
    const images = validateProviderImages(input.images);
    const status = await this.accountStatus(input.signal);
    if (!status.authenticated || status.authMode !== 'chatgpt') throw new Error('Sign in to ChatGPT through HIVE before using the subscription provider.');
    const response = record(await this.request('thread/start', {
      model: input.model, modelProvider: 'openai', allowProviderModelFallback: false,
      cwd: this.cwd, runtimeWorkspaceRoots: [this.cwd], approvalPolicy: 'never', sandbox: 'read-only',
      ephemeral: true, environments: [], dynamicTools: [], selectedCapabilityRoots: [],
      baseInstructions: input.systemPrompt ?? 'Return the requested assistant response. HIVE owns tool execution; do not call tools.',
      developerInstructions: 'This is a HIVE provider completion. Return text only. Never execute native Codex tools, shell, file operations, plugins, MCP, web or subagents. If HIVE requests a JSON response with toolCalls, emit that JSON as plain text: HIVE validates and executes those requests separately. Emitting JSON is not native tool execution.',
    }, input.signal), 'thread start');
    const thread = record(response.thread, 'thread');
    const threadId = requiredString(thread.id, 'thread ID');
    if (response.model !== input.model || response.modelProvider !== 'openai') throw new Error('Codex selected a different model or provider; refusing silent fallback.');
    if (thread.ephemeral !== true) throw new Error('Codex did not create an ephemeral provider thread.');
    if (!Array.isArray(response.instructionSources) || response.instructionSources.length) throw new Error('Codex loaded ambient instruction files; provider completion refused.');
    const sandbox = record(response.sandbox, 'sandbox policy');
    if (sandbox.type !== 'readOnly' || sandbox.networkAccess !== false || response.approvalPolicy !== 'never') throw new Error('Codex did not apply the required read-only, network-disabled tool sandbox.');
    let output = '';
    let usage: ProviderCompletionResult['usage'];
    const itemTexts = new Map<string, string>();
    const commentaryItems = new Set<string>();
    let itemTextBytes = 0;
    let turnId: string | undefined;
    let settled = false;
    let succeeded = false;
    let finish!: (error?: Error) => void;
    const completed = new Promise<void>((resolve, reject) => { finish = (error) => { if (settled) return; settled = true; if (error) reject(error); else resolve(); }; });
    // Attach immediately so an early terminal event cannot create an unhandled rejection.
    void completed.catch(() => {});
    const listener = (notification: Notification) => {
      if (notification.method === 'hive/closed') return finish(this.failure ?? new Error('Codex app-server closed during completion.'));
      if (notification.method === 'hive/toolRejected') return finish(new Error('Codex attempted tool execution; HIVE refused the provider completion.'));
      const params = notification.params;
      if (params.threadId !== threadId) return;
      if (turnId && typeof params.turnId === 'string' && params.turnId !== turnId) return;
      try {
        if (notification.method === 'model/rerouted') return finish(new Error('Codex rerouted the requested model; completion refused.'));
        if (notification.method === 'item/started' || notification.method === 'item/completed') {
          const item = record(params.item, 'turn item');
          if (!['userMessage', 'agentMessage', 'reasoning', 'contextCompaction'].includes(String(item.type))) return finish(new Error('Codex attempted a built-in capability; HIVE refused the provider completion.'));
          if (item.type === 'agentMessage') {
            const id = requiredString(item.id, 'message ID');
            if (!itemTexts.has(id) && !commentaryItems.has(id) && itemTexts.size + commentaryItems.size >= 256) return finish(new Error('Codex completion exceeded its message count limit.'));
            if (item.phase === 'commentary') commentaryItems.add(id);
            else if (notification.method === 'item/completed') {
              const text = typeof item.text === 'string' ? item.text : '';
              itemTextBytes += Buffer.byteLength(text) - Buffer.byteLength(itemTexts.get(id) ?? '');
              if (itemTextBytes > MAX_OUTPUT_BYTES) return finish(new Error('Codex completion exceeded its output size limit.'));
              itemTexts.set(id, text);
            }
          }
        } else if (notification.method === 'item/agentMessage/delta') {
          if (typeof params.itemId === 'string' && commentaryItems.has(params.itemId)) return;
          const delta = typeof params.delta === 'string' ? params.delta : '';
          output += delta;
          if (Buffer.byteLength(output) > MAX_OUTPUT_BYTES) return finish(new Error('Codex completion exceeded its output size limit.'));
          onChunk?.(delta);
        } else if (notification.method === 'thread/tokenUsage/updated') {
          const last = record(record(params.tokenUsage, 'token usage').last, 'token usage totals');
          if ([last.inputTokens, last.outputTokens, last.totalTokens].every((value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)) {
            usage = { promptTokens: Number(last.inputTokens), completionTokens: Number(last.outputTokens), totalTokens: Number(last.totalTokens) };
          }
        } else if (notification.method === 'turn/completed') {
          const turn = record(params.turn, 'completed turn');
          if (turnId && turn.id !== turnId) return;
          if (turn.status !== 'completed') return finish(new Error(`Codex completion ${turn.status === 'interrupted' ? 'was interrupted' : 'failed'}.`));
          succeeded = true; finish();
        } else if (notification.method === 'error' && params.willRetry !== true) finish(new Error('Codex reported a provider error.'));
      } catch (error) { finish(error instanceof Error ? error : new Error('Invalid Codex completion event.')); }
    };
    const abort = () => finish(input.signal?.reason instanceof Error ? input.signal.reason : new Error('Codex completion aborted.'));
    const timer = setTimeout(() => finish(new Error('Codex completion timed out.')), 300_000);
    this.listeners.add(listener); input.signal?.addEventListener('abort', abort, { once: true });
    try {
      const started = record(await this.request('turn/start', { threadId, input: [
        { type: 'text', text: input.prompt, text_elements: [] },
        ...images.map((image) => ({ type: 'image', url: `data:${image.mimeType};base64,${image.data}` })),
      ], environments: [] }, input.signal), 'turn start');
      turnId = requiredString(record(started.turn, 'turn').id, 'turn ID');
      await completed;
      if (!output && itemTexts.size) {
        output = [...itemTexts.values()].join('\n');
        if (Buffer.byteLength(output) > MAX_OUTPUT_BYTES) throw new Error('Codex completion exceeded its output size limit.');
        onChunk?.(output);
      }
      return { output, ...(usage ? { usage } : {}) };
    } finally {
      clearTimeout(timer); this.listeners.delete(listener); input.signal?.removeEventListener('abort', abort);
      if (!succeeded) {
        if (turnId) await this.request('turn/interrupt', { threadId, turnId }).catch(() => {});
      }
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.fail(new Error('Codex app-server closed.'));
    this.child.stdin.destroy();
    if (this.child.exitCode === null) await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2_000);
      this.child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    await rm(this.cwd, { recursive: true, force: true });
  }
}

export async function createCodexAppServer(options: CodexAppServerOptions = {}): Promise<CodexAppServer> {
  options.signal?.throwIfAborted();
  const home = path.resolve(options.homeDir ?? path.join(homedir(), '.hive', 'chatgpt'));
  const externalHome = path.resolve(homedir(), '.codex');
  if (home.toLowerCase() === externalHome.toLowerCase() || home.toLowerCase().startsWith(`${externalHome.toLowerCase()}${path.sep}`)) throw new Error('HIVE ChatGPT sign-in must use its own auth home, separate from other Codex clients.');
  if (options.requestTimeoutMs !== undefined && (!Number.isSafeInteger(options.requestTimeoutMs) || options.requestTimeoutMs < 1 || options.requestTimeoutMs > 300_000)) throw new Error('Invalid Codex request timeout.');
  await mkdir(home, { recursive: true, mode: 0o700 });
  const canonicalHome = await realpath(home);
  const canonicalOtherHome = await realpath(externalHome).catch(() => externalHome);
  if ((await lstat(home)).isSymbolicLink() || canonicalHome.toLowerCase() === canonicalOtherHome.toLowerCase() || canonicalHome.toLowerCase().startsWith(`${canonicalOtherHome.toLowerCase()}${path.sep}`)) throw new Error('HIVE ChatGPT auth home must not link to another Codex client.');
  // This is an auth/runtime home, not an extra source of MCP servers, hooks or plugins.
  // Refuse customization instead of overwriting user files or launching configured processes.
  const configFile = path.join(home, 'config.toml');
  try {
    const configStat = await lstat(configFile);
    if (!configStat.isFile() || configStat.isSymbolicLink() || configStat.size > 65_536 || (await readFile(configFile, 'utf8')).trim()) throw new Error('HIVE ChatGPT auth home must not contain a custom config.toml. Use HIVE provider settings instead.');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  for (const name of ['hooks.json', 'plugins', 'skills', 'agents', 'mcp.json']) {
    try {
      const entry = await lstat(path.join(home, name));
      // Codex installs its bundled skills/.system directory on first launch.
      const entries = entry.isDirectory() && !entry.isSymbolicLink() ? await readdir(path.join(home, name)) : undefined;
      if (entries && entries.every((child) => name === 'skills' && child === '.system')) continue;
      throw new Error(`HIVE ChatGPT auth home must not contain custom ${name}. Configure extensions through HIVE instead.`);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  }
  const cwd = await mkdtemp(path.join(tmpdir(), 'hive-chatgpt-'));
  try { options.signal?.throwIfAborted(); } catch (error) { await rm(cwd, { recursive: true, force: true }); throw error; }
  const child = spawn(options.executable ?? 'codex', [...(options.args ?? []), 'app-server', '--stdio', ...CHILD_CONFIG.flatMap((value) => ['-c', value])], {
    cwd, env: childEnvironment(home), shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const client = new CodexAppServer(child, cwd, options.requestTimeoutMs ?? 30_000);
  try { await client.initialize(options.signal); return client; }
  catch (error) { await client.close(); throw error; }
}
