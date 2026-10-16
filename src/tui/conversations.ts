import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { redactStreamingText } from "../security/secrets.js";
import type { TuiState } from "./state.js";
import type { HiveMode } from "../config.js";

export interface CliConversation {
  schemaVersion: 1;
  id: string;
  cwd: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  transcript: string[];
  history: string[];
  summary: string;
  contextStart?: number;
  mode: HiveMode;
  model?: { providerId: string; model: string };
  codingSessionId?: string;
  codingStatus?: string;
  detachedCodingSessionId?: string;
  forkedFrom?: string;
  skillIds?: string[];
  mcpServerIds?: string[];
  lspServerIds?: string[];
  pluginAgentId?: string;
  outputStyleId?: string;
  imagePaths?: string[];
}

const ID = /^cli-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_BYTES = 16 * 1024 * 1024;
export const CONTEXT_CHAR_BUDGET = 48_000;

function safeId(id: string): void {
  if (!ID.test(id)) throw new Error("Invalid CLI conversation id.");
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertConversation(value: unknown): asserts value is CliConversation {
  if (!record(value) || value.schemaVersion !== 1 || typeof value.id !== "string") throw new Error("Invalid CLI conversation schema.");
  safeId(value.id);
  const keys = new Set(["schemaVersion", "id", "cwd", "title", "createdAt", "updatedAt", "messages", "transcript", "history", "summary", "contextStart", "mode", "model", "codingSessionId", "codingStatus", "detachedCodingSessionId", "forkedFrom", "skillIds", "mcpServerIds", "lspServerIds", "pluginAgentId", "outputStyleId", "imagePaths"]);
  if (Object.keys(value).some((key) => !keys.has(key))) throw new Error("Unexpected CLI conversation field.");
  for (const key of ["cwd", "title", "createdAt", "updatedAt", "summary"]) {
    if (typeof value[key] !== "string") throw new Error(`Invalid conversation ${key}.`);
  }
  if (!path.isAbsolute(String(value.cwd)) || String(value.title).length > 200) throw new Error("Invalid conversation location or title.");
  if (!Number.isFinite(Date.parse(String(value.createdAt))) || !Number.isFinite(Date.parse(String(value.updatedAt)))) throw new Error("Invalid conversation timestamp.");
  if (!["guarded", "standard", "autonomous", "plan", "review"].includes(String(value.mode))) throw new Error("Invalid conversation mode.");
  for (const key of ["transcript", "history"]) {
    if (!Array.isArray(value[key]) || value[key].length > 100_000 || !value[key].every((entry: unknown) => typeof entry === "string")) throw new Error(`Invalid conversation ${key}.`);
  }
  if (!Array.isArray(value.messages) || value.messages.length > 20_000) throw new Error("Invalid conversation messages.");
  for (const message of value.messages) {
    if (!record(message) || Object.keys(message).some((key) => key !== "role" && key !== "content") || !["user", "assistant"].includes(String(message.role)) || typeof message.content !== "string") throw new Error("Invalid conversation message.");
  }
  if (value.contextStart !== undefined && (!Number.isSafeInteger(value.contextStart) || Number(value.contextStart) < 0 || Number(value.contextStart) > value.messages.length)) throw new Error("Invalid conversation context boundary.");
  if (value.model !== undefined && (!record(value.model) || Object.keys(value.model).some((key) => key !== "providerId" && key !== "model") || typeof value.model.providerId !== "string" || typeof value.model.model !== "string")) throw new Error("Invalid conversation model.");
  for (const key of ["codingSessionId", "codingStatus", "detachedCodingSessionId", "forkedFrom", "pluginAgentId", "outputStyleId"]) {
    if (value[key] !== undefined && typeof value[key] !== "string") throw new Error(`Invalid conversation ${key}.`);
  }
  for (const key of ["skillIds", "mcpServerIds", "lspServerIds", "imagePaths"]) {
    const entries = value[key];
    if (entries !== undefined && (!Array.isArray(entries) || entries.length > 16 || !entries.every((entry: unknown) => typeof entry === "string" && entry.length <= 1_024 && !/[\x00-\x1f]/.test(entry)))) throw new Error(`Invalid conversation ${key}.`);
  }
}

function cleanConversation(value: CliConversation): CliConversation {
  return {
    ...value,
    title: redactStreamingText(value.title),
    summary: redactStreamingText(value.summary),
    messages: value.messages.map((message) => ({ ...message, content: redactStreamingText(message.content) })),
    transcript: value.transcript.map(redactStreamingText),
    history: value.history.map(redactStreamingText),
  };
}

export function newConversation(cwd: string, mode: HiveMode = "guarded"): CliConversation {
  const now = new Date().toISOString();
  return { schemaVersion: 1, id: `cli-${randomUUID()}`, cwd: path.resolve(cwd), title: "New conversation", createdAt: now, updatedAt: now, messages: [], transcript: [], history: [], summary: "", mode };
}

export class CliConversationStore {
  constructor(private readonly cwd: string) {}

  private async directory(): Promise<string> {
    const root = await fs.realpath(this.cwd);
    let directory = root;
    for (const name of [".hivemind", "cli-sessions"]) {
      directory = path.join(directory, name);
      await fs.mkdir(directory).catch((error: unknown) => {
        if (!record(error) || error.code !== "EEXIST") throw error;
      });
      const stat = await fs.lstat(directory);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("CLI session storage must be a real directory inside the workspace.");
    }
    return directory;
  }

  async save(conversation: CliConversation): Promise<void> {
    assertConversation(conversation);
    const root = await fs.realpath(this.cwd);
    if (await fs.realpath(conversation.cwd) !== root) throw new Error("Conversation belongs to another workspace.");
    const directory = await this.directory();
    const snapshot = cleanConversation({ ...conversation, cwd: root, updatedAt: new Date().toISOString() });
    const serialized = JSON.stringify(snapshot, null, 2) + "\n";
    if (Buffer.byteLength(serialized) > MAX_BYTES) throw new Error("CLI conversation exceeds the storage limit; export it before starting another session.");
    const temporary = path.join(directory, `.${conversation.id}.${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, serialized, { flag: "wx", mode: 0o600 });
      await fs.rename(temporary, path.join(directory, `${conversation.id}.json`));
    } finally { await fs.rm(temporary, { force: true }); }
  }

  async load(id: string): Promise<CliConversation | undefined> {
    safeId(id);
    const file = path.join(await this.directory(), `${id}.json`);
    let stat;
    try { stat = await fs.lstat(file); }
    catch (error) { if (record(error) && error.code === "ENOENT") return undefined; throw error; }
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_BYTES) throw new Error("Unsafe CLI conversation file.");
    const parsed: unknown = JSON.parse(await fs.readFile(file, "utf8"));
    assertConversation(parsed);
    if (parsed.id !== id || await fs.realpath(parsed.cwd) !== await fs.realpath(this.cwd)) throw new Error("CLI conversation identity does not match this workspace.");
    return cleanConversation(parsed);
  }

  async list(): Promise<{ records: CliConversation[]; warnings: string[] }> {
    const directory = await this.directory();
    const records: CliConversation[] = [];
    const warnings: string[] = [];
    for (const entry of await fs.readdir(directory)) {
      if (!entry.endsWith(".json") || !ID.test(entry.slice(0, -5))) continue;
      try { const value = await this.load(entry.slice(0, -5)); if (value) records.push(value); }
      catch { warnings.push(`Could not read ${entry}; the original file was preserved.`); }
    }
    return { records: records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), warnings };
  }
}

export function conversationContext(conversation: CliConversation, prompt: string): string {
  const current = `[Current request]\n${prompt}`;
  let remaining = Math.max(0, CONTEXT_CHAR_BUDGET - current.length);
  const prior: string[] = [];
  for (const message of conversation.messages.slice(conversation.contextStart ?? 0).reverse()) {
    const text = `[Prior ${message.role}]\n${message.content}`;
    if (text.length > remaining) break;
    prior.unshift(text);
    remaining -= text.length;
  }
  const summary = conversation.summary.slice(0, remaining);
  return [summary && `[Earlier conversation summary]\n${summary}`, ...prior, current].filter(Boolean).join("\n\n");
}

export function conversationSnapshot(state: TuiState): CliConversation | undefined {
  if (!state.conversation) return undefined;
  return { ...state.conversation, transcript: state.liveText ? [...state.transcript, state.liveText] : state.transcript, history: state.history, mode: state.sessionMode, updatedAt: new Date().toISOString() };
}

export async function persistConversation(cwd: string, state: TuiState): Promise<void> {
  const snapshot = conversationSnapshot(state);
  if (snapshot) await new CliConversationStore(cwd).save(snapshot);
}

export async function reconcileCodingConversation(cwd: string, state: TuiState): Promise<TuiState> {
  const conversation = state.conversation;
  if (!conversation?.codingSessionId || conversation.detachedCodingSessionId === conversation.codingSessionId) return state;
  const { findRepositoryRoot } = await import("../coding/repository.js");
  const { CodingSessionStore } = await import("../coding/session-store.js");
  const record = await new CodingSessionStore(await findRepositoryRoot(cwd)).load(conversation.codingSessionId);
  if (!record) throw new Error(`Saved coding run ${conversation.codingSessionId} is missing; conversation history is preserved.`);
  return { ...state, conversation: { ...conversation, codingStatus: record.status } };
}
