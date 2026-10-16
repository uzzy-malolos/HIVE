import fs from "node:fs/promises";
import path from "node:path";
import { CoderOrchestrator } from "./orchestrator.js";
import { StandaloneExecutor } from "./api-client.js";
import { GitHubForge } from "./forge.js";
import { TaskStore } from "./store.js";
import { ProviderRegistry } from "./providers/registry.js";
import { ProviderRole, ProviderSnapshot } from "./types.js";
import { getHiveHelpHeader, getHiveProvidersHeader, getHiveRunHeader, renderDashboard, renderStatus, runProviderSetupWizard } from "./ui/index.js";
import { ConfigStore, HiveMode } from "./config.js";
import { shouldSuppressBranding, isCI } from "./ui/terminal.js";
import { runCodeCommand, type CodingRuntimeFactory } from "./coding/command.js";
import { CODE_COMMAND_HELP } from "./coding/cli-options.js";
import { CodingSessionStore } from "./coding/session-store.js";
import { findRepositoryRoot } from "./coding/repository.js";
import { withCodingSessionLeaseAtRoot } from "./coding/session-lease.js";
import type { CodingSessionRecord } from "./coding/types.js";
import { forkCodingSession } from "./coding/fork.js";
import { inspectManagedWorktree, recordUserWorkspaceChange } from "./coding/runtime.js";
import { maybeLaunchSession, type TuiLaunchOptions } from "./tui/launch.js";
import type { ExtensionOptions } from "./extensions/types.js";
import { verifyProvider } from "./providers/verification.js";
import { providerCatalog, providerCommand } from "./providers/commands.js";
import {
  createHiveRunReport,
  formatHiveRunReportMarkdown,
  writeHiveRunReport,
  resolveHiveRunReportOutput,
} from "./coding/report.js";

export interface CoderCliOptions extends TuiLaunchOptions {
  cwd?: string;
  /** Receives live coding runtime lines. The CLI binary uses this for streaming output. */
  stream?: (line: string) => void;
  /** Injectable coding runtime boundary for tests and embedders. */
  codingRuntimeFactory?: CodingRuntimeFactory;
  signal?: AbortSignal;
  extensionOptions?: ExtensionOptions;
}

export type CoderCliResult = {
  exitCode: number;
  output: string;
};

async function getActiveTask(cwd: string): Promise<string> {
  const p = path.join(cwd, ".hivemind", "coder-tasks", "active-task.txt");
  try {
    const content = await fs.readFile(p, "utf-8");
    return content.trim();
  } catch (err) {
    throw new Error("No active task found. Run 'hive run <task>' first.");
  }
}

async function getActiveTaskSafe(cwd: string): Promise<string | null> {
  try {
    return await getActiveTask(cwd);
  } catch {
    return null;
  }
}

async function setActiveTask(cwd: string, taskId: string): Promise<void> {
  const dir = path.join(cwd, ".hivemind", "coder-tasks");
  await fs.mkdir(dir, { recursive: true });
  const p = path.join(dir, "active-task.txt");
  await fs.writeFile(p, taskId, "utf-8");
}

async function clearActiveTask(cwd: string): Promise<void> {
  const p = path.join(cwd, ".hivemind", "coder-tasks", "active-task.txt");
  await fs.rm(p, { force: true }).catch(() => {});
}

function sessionStateLabel(state: string, archived: boolean | undefined): string {
  return archived ? `${state}, archived` : state;
}

function assertSessionRestorable(kind: "coding" | "legacy", id: string, archived: boolean | undefined): void {
  if (!archived) return;
  const label = kind === "coding" ? "Coding session" : "Task cell";
  throw new Error(`${label} ${id} is archived. Run 'hive sessions unarchive ${id}' to restore it.`);
}

function archiveResult(
  kind: "coding" | "legacy",
  id: string,
  archived: boolean,
  already: boolean,
  json: boolean,
): CoderCliResult {
  const label = kind === "coding" ? "Coding session" : "Task cell";
  const noun = kind === "coding" ? "coding session" : "task cell";
  if (json) {
    return {
      exitCode: 0,
      output: JSON.stringify({
        success: true,
        kind,
        id,
        archived,
        ...(already ? { unchanged: true } : {}),
      }),
    };
  }
  if (already && archived) return { exitCode: 0, output: `${label} ${id} is already archived.` };
  if (already && !archived) return { exitCode: 0, output: `${label} ${id} is not archived.` };
  if (archived) return { exitCode: 0, output: `Archived ${noun} ${id}.` };
  return { exitCode: 0, output: `Restored ${noun} ${id}.` };
}

async function withCodingRecord<T>(root: string, id: string, operation: (record: CodingSessionRecord, store: CodingSessionStore) => Promise<T>, signal?: AbortSignal): Promise<T> {
  return withCodingSessionLeaseAtRoot(root, id, async () => {
    const store = new CodingSessionStore(root);
    const record = await store.load(id);
    if (!record) throw new Error(`Coding session ${id} not found.`);
    return operation(record, store);
  }, signal);
}

function parseRunArgs(args: string[]): { prompt: string; options: Record<string, string> } {
  const options: Record<string, string> = {};
  const promptParts: string[] = [];
  
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      if (i + 1 < args.length && !args[i+1].startsWith('--')) {
        options[key] = args[i+1];
        i++;
      } else {
        options[key] = "true";
      }
    } else {
      promptParts.push(args[i]);
    }
  }
  
  return { prompt: promptParts.join(" "), options };
}

export async function runCoderCli(args: string[], cliOptions: CoderCliOptions = {}): Promise<CoderCliResult> {
  const launched = await maybeLaunchSession(args, cliOptions);
  if (launched) return launched;
  const cwd = cliOptions.cwd || process.cwd();
  const store = new TaskStore(cwd);
  const codingRoot = await findRepositoryRoot(cwd).catch(() => cwd);
  const codingStore = new CodingSessionStore(codingRoot);
  const registry = new ProviderRegistry(codingRoot);
  const configStore = new ConfigStore(cwd);
  const currentMode = await configStore.getMode();

  const isSuppressed = args.includes("--json") || shouldSuppressBranding();

  // If help flag is used anywhere top level, treat it as help command
  if (args.includes("--help") || args.includes("-h")) {
    if (args[0] === "code") {
      return { exitCode: 0, output: CODE_COMMAND_HELP };
    } else if (args[0] === "providers") {
      args = ["providers", "help"];
    } else {
      args = ["help"];
    }
  }

  // Filter out options so command parsing is clean
  const globalArgs = args.filter(a => !a.startsWith('--'));

  if (globalArgs.length === 0) {
    if (process.stdout.isTTY && !isSuppressed && !isCI()) {
      // Persistent interactive TUI cockpit
      const { startHiveTui } = await import("./tui/index.js");
      await startHiveTui(cwd);
      return { exitCode: 0, output: "__TUI_STARTED__" };
    } else {
      const providers = await registry.list();
      const rolesConfig = await registry.getRoles();
      const tasks = await store.list();
      const rolesAssigned = [];
      if (rolesConfig.planner) rolesAssigned.push("Planner");
      if (rolesConfig.builder) rolesAssigned.push("Builder");
      if (rolesConfig.validator) rolesAssigned.push("Validator");
      if (rolesConfig.reviewer) rolesAssigned.push("Reviewer");

      const out = renderDashboard({
        providersApproved: providers.filter(p => p.approved).length,
        rolesAssigned,
        tasksCount: tasks.length,
        mode: currentMode
      });
      return { exitCode: 0, output: out };
    }
  }

  if (globalArgs[0] === "tui") {
    if (isSuppressed) return { exitCode: 1, output: JSON.stringify({ error: "TUI not available in --json mode" }) };
    if (isCI()) return { exitCode: 1, output: "TUI is disabled in CI environments." };
    if (!process.stdout.isTTY) return { exitCode: 1, output: "TUI requires an interactive terminal." };
    const { startHiveTui } = await import("./tui/index.js");
    await startHiveTui(cwd);
    return { exitCode: 0, output: "__TUI_STARTED__" };
  }

  if (globalArgs[0] === "help") {
    const header = getHiveHelpHeader();
    const helpContent = `
Usage:
  hive                             Interactive session when stdout is a TTY
  hive "<prompt>"                  Start an interactive conversation
  hive -p "<prompt>"               Run one headless turn
  hive -p -                        Read an explicit stdin prompt (20,000 chars)
  hive -r <conversation-id>         Resume a CLI conversation
  hive -c                          Continue the latest CLI conversation
  hive code "<objective>" [options]
  hive code --resume <session-id> [options]
  hive run "<task>"
  hive tui
  hive status
  hive diff [--full]
  hive approve
  hive discard
  hive push --confirmed
  hive pr --confirmed
  hive providers setup
  hive providers list
  hive sessions [list]
  hive sessions show <id>
  hive sessions fork <id>
  hive sessions adopt <id> [--confirmed --fingerprint <preview-hash>]
  hive sessions archive <id>
  hive sessions unarchive <id>
  hive resume <id>
  hive agents [show <id>]
  hive report <session-id> [--json|--markdown] [--output <path>]
  hive mode
  hive chat ["message"] [--role <slug>] [--json] [--agent] [--ground] [--model <provider/model>] [--resume <id>]
  hive hivebot "<task>" [--preset <quick|standard|deep|audit>] [--provider <id>] [--model <m>]
  hive scout [--task "<task>"] [--json] [--files]

Conversation launch options:
  -p, --print                  Run without opening the interactive TUI
  -r, --resume <id>            Restore a saved CLI conversation
  -c, --continue               Restore the latest CLI conversation
  -m, --model <provider/model> Select a configured model for this conversation
  --image <workspace-file>    Attach an image; may be repeated
  --cwd <directory>           Select the workspace for this invocation
  --plan | --review           Use a read-only mode for this invocation
  --json                     Return a JSON result
  --output-format <format>    plain, json, or streaming-json
  --fork-session             Fork a restored conversation and its coding worktree

Chat options:
  --role <slug>               Pick a persona (planning, coding, heavy-reasoning,
                              game-builder, project-coworker, study-buddy; kebab
                              or camel cases accepted; "auto" classifies).
  --agent                     Agentic mode: read-only tools for grounding (no writes).
  --ground                    Inject a bounded Scout context pack into the system
                              prompt (toggle in-REPL with /ground on|off|refresh).
  --json                      Emit newline-delimited JSON events (requires a message).
  --model <provider/model>    Manual provider + model override.
  --resume <id>               Resume a saved chat session before the first prompt.

Hivebot options:
  --preset <quick|standard|deep|audit>  Force a council budget preset.
  --provider <id>             Force the provider for every council stage.
  --model <m>                 Force the model for every council stage.

Safety:
  worktree isolation - approve-before-commit - no auto-push - secret redaction`;
    const full = (header ? header + "\n\n" : "") + helpContent.trim();
    return { exitCode: 0, output: full };
  }
  
  const [command, ...rest] = globalArgs;
  
  try {
    if (command === "lsp") {
      const { lspCommand } = await import("./extensions/plugin-commands.js");
      const lines = await lspCommand(cwd, args.slice(args.indexOf(command) + 1).filter((arg) => arg !== "--json"), { ...cliOptions.extensionOptions, signal: cliOptions.signal });
      return { exitCode: 0, output: args.includes("--json") ? JSON.stringify({ kind: command, lines }) : lines.join("\n") };
    }
    if (command === "plugins" && ["agents", "agent", "run-agent"].includes(rest[0])) {
      const { pluginComponentCommand } = await import("./extensions/plugin-commands.js");
      let status: string | undefined;
      const lines = await pluginComponentCommand(cwd, args.slice(args.indexOf(command) + 1).filter((arg) => arg !== "--json"), { ...cliOptions.extensionOptions, signal: cliOptions.signal,
        runAgent: async (pluginAgentId, objective) => {
          const { runQueenTuiSession } = await import("./tui/runtime-adapter.js");
          const result = await runQueenTuiSession({ cwd, objective, pluginAgentId, signal: cliOptions.signal ?? new AbortController().signal, extensionOptions: cliOptions.extensionOptions,
            onEvent: (event) => cliOptions.stream?.(args.includes("--json") ? JSON.stringify({ type: "agent.progress", event: event.type }) : event.type),
            onText: (text) => cliOptions.stream?.(args.includes("--json") ? JSON.stringify({ type: "agent.text", text }) : text) });
          if (!result || typeof result !== "object" || !("status" in result) || !("id" in result) || typeof result.id !== "string" || typeof result.status !== "string") throw new Error("Plugin agent coding runtime returned an invalid result");
          status = result.status;
          return [`Plugin agent ${pluginAgentId}: coding session ${result.id} (${status}).`, `Inspect it with hive sessions show ${result.id}.`];
        } });
      return { exitCode: status === "cancelled" ? 130 : status === "paused" ? 2 : status && status !== "completed" ? 1 : 0, output: args.includes("--json") ? JSON.stringify({ kind: command, lines }) : lines.join("\n") };
    }
    if (command === "mcp" || command === "skills" || command === "plugins" || command === "hooks") {
      const { extensionCommand } = await import("./extensions/index.js");
      const extensionArgs = args.slice(args.indexOf(command) + 1).filter((arg) => arg !== "--json");
      const lines = await extensionCommand(cwd, command, extensionArgs.join(" "), { ...cliOptions.extensionOptions, signal: cliOptions.signal,
        onProgress: cliOptions.stream ? (line) => cliOptions.stream?.(args.includes("--json") ? JSON.stringify({ type: "extension.progress", kind: command, text: line }) : line) : undefined });
      return { exitCode: 0, output: args.includes("--json") ? JSON.stringify({ kind: command, lines }) : lines.join("\n") };
    }
    if (command === "code") {
      if (args.length === 1 && process.stdout.isTTY && !isCI()) {
        const { startHiveTui } = await import("./tui/index.js");
        await startHiveTui(cwd);
        return { exitCode: 0, output: "__TUI_STARTED__" };
      }
      return await runCodeCommand(args.slice(1), cwd, {
        createRuntime: cliOptions.codingRuntimeFactory,
        onLine: cliOptions.stream,
        signal: cliOptions.signal,
        extensionOptions: cliOptions.extensionOptions,
      });
    }

    if (command === "report") {
      const reportArgs = args.slice(1);
      let sessionId: string | undefined;
      let outputPath: string | undefined;
      let format: "json" | "markdown" = "markdown";
      let formatWasSet = false;
      for (let index = 0; index < reportArgs.length; index += 1) {
        const argument = reportArgs[index];
        if (argument === "--json" || argument === "--markdown") {
          if (formatWasSet) throw new Error("Choose exactly one report format.");
          format = argument === "--json" ? "json" : "markdown";
          formatWasSet = true;
        } else if (argument === "--output") {
          const value = reportArgs[index + 1];
          if (!value || value.startsWith("--")) throw new Error("--output requires a path.");
          if (outputPath) throw new Error("--output may only be specified once.");
          outputPath = value;
          index += 1;
        } else if (argument.startsWith("--")) {
          throw new Error(`Unknown report option: ${argument}`);
        } else if (sessionId) {
          throw new Error("Usage: hive report <session-id> [--json|--markdown] [--output <path>]");
        } else {
          sessionId = argument;
        }
      }
      if (!sessionId) throw new Error("Usage: hive report <session-id> [--json|--markdown] [--output <path>]");
      const session = await codingStore.load(sessionId);
      if (!session) throw new Error(`Coding session ${sessionId} not found.`);
      const report = createHiveRunReport(session);
      const rendered = format === "json"
        ? `${JSON.stringify(report, null, 2)}\n`
        : formatHiveRunReportMarkdown(report);
      if (!outputPath) return { exitCode: 0, output: rendered };
      const written = await writeHiveRunReport(codingRoot, outputPath, rendered);
      return { exitCode: 0, output: `Report written to ${path.relative(codingRoot, written)}.` };
    }

    if (command === "resume") {
      const id = rest[0];
      if (!id) throw new Error("Usage: hive resume <id>");
      const coding = await codingStore.load(id);
      if (coding) {
        assertSessionRestorable("coding", id, coding.archived);
        await codingStore.setActive(id);
        return await runCodeCommand([
          "--resume", id,
          "--mode", coding.mode,
          "--approval", coding.approvalPolicy,
          "--no-tui",
          ...(args.includes("--json") ? ["--json"] : []),
        ], cwd, {
          createRuntime: cliOptions.codingRuntimeFactory,
          onLine: cliOptions.stream,
          signal: cliOptions.signal,
        });
      }
      const legacy = await store.load(id);
      if (!legacy) throw new Error(`Session ${id} not found.`);
      assertSessionRestorable("legacy", id, legacy.archived);
      await setActiveTask(cwd, id);
      if (isSuppressed) return { exitCode: 0, output: JSON.stringify({ success: true, id, kind: "legacy" }) };
      return { exitCode: 0, output: `Resumed task cell ${id}.` };
    }

    if (command === "agents") {
      const codingSessions = await codingStore.list();
      if (rest[0] === "show") {
        const id = rest[1];
        if (!id) throw new Error("Usage: hive agents show <id>");
        const active = await codingStore.getActive();
        const candidates = active
          ? [active, ...codingSessions.filter((session) => session.id !== active.id)]
          : codingSessions;
        for (const session of candidates) {
          const agent = session.tasks.find((task) => task.id === id);
          if (agent) return { exitCode: 0, output: JSON.stringify(agent, null, 2) };
        }
        throw new Error(`Subagent ${id} not found.`);
      }
      if (rest.length > 0) return { exitCode: 1, output: "Usage: hive agents [show <id>]" };
      const agents = codingSessions.flatMap((session) => session.tasks);
      if (isSuppressed) return { exitCode: 0, output: JSON.stringify(agents) };
      if (agents.length === 0) return { exitCode: 0, output: "No coding subagents found." };
      return {
        exitCode: 0,
        output: agents.map((agent) => `${agent.id} [${agent.role}] ${agent.status} - ${agent.title} (${agent.sessionId})`).join("\n"),
      };
    }

    if (command === "providers") {
      if (rest.length === 0) return { exitCode: 1, output: "Usage: hive providers <setup|list|add|test|verify|approve|remove|roles>" };
      const [sub, ...subRest] = rest;
      
      if (["list", "add", "test", "approve", "models", "presets", "login", "auth-status", "logout"].includes(sub)) {
        const providerArgs = args.slice(args.indexOf("providers") + 1).filter((arg) => arg !== "--json");
        const result = await providerCommand(codingRoot, providerArgs.length ? providerArgs : ["list"], { signal: cliOptions.signal, onProgress: cliOptions.stream ? (text) => cliOptions.stream?.(isSuppressed ? JSON.stringify({ type: "provider.login", text }) : text) : undefined });
        return { exitCode: result.exitCode, output: isSuppressed ? JSON.stringify(result.data) : result.lines.join("\n") };
      }

      if (sub === "setup") {
        if (args.includes("--json") || !process.stdin.isTTY) throw new Error("Interactive provider setup requires a terminal. Use hive providers presets and hive providers add --id ID --preset PRESET --model MODEL for BYOK or local setup.");
        await runProviderSetupWizard(registry, { signal: cliOptions.signal });
        return { exitCode: 0, output: "" };
      }
      
      if (sub === "help") {
        const header = getHiveProvidersHeader();
        const helpContent = `
Commands:
  hive providers setup
  hive providers list
  hive providers presets
  hive providers add --id <id> --preset <openai|anthropic|google|openrouter|custom|hive-cloud|ollama|local> --model <model> [--base-url <url>] [--api-key-env <name>]
  hive providers add --id <id> --kind <kind> [--base-url <url>] [--api-key-env <name>] [--model <model>]
  hive providers models <id>
  hive providers login <id> [--device]
  hive providers auth-status <id>
  hive providers logout <id>
  hive providers test <id>
  hive providers verify <id> [--model <id>] [--coding] [--max-output-tokens <n>] [--timeout-ms <n>] [--output <file>] [--json]
  hive providers approve <id>
  hive providers remove <id>
  hive providers roles`;
        const full = (header ? header + "\n\n" : "") + helpContent.trim();
        return { exitCode: 0, output: full };
      }
      
      if (sub === "verify") {
        const verificationArgs = args.slice(args.indexOf("providers") + 2).filter((arg) => arg !== "--json");
        const id = verificationArgs[0];
        if (!id || id.startsWith("--")) throw new Error("Usage: hive providers verify <id> [--model <id>] [--coding] [--json]");
        let model: string | undefined;
        let coding = false;
        let maxOutputTokens: number | undefined;
        let timeoutMs: number | undefined;
        let output: string | undefined;
        for (let index = 1; index < verificationArgs.length; index += 1) {
          const flag = verificationArgs[index];
          if (flag === "--coding") { coding = true; continue; }
          if (!["--model", "--max-output-tokens", "--timeout-ms", "--output"].includes(flag)) throw new Error(`Unknown verification option: ${flag}`);
          const value = verificationArgs[++index];
          if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
          if (flag === "--model") model = value;
          else if (flag === "--output") output = value;
          else if (flag === "--max-output-tokens") maxOutputTokens = Number(value);
          else timeoutMs = Number(value);
        }
        if (output) await resolveHiveRunReportOutput(cwd, output);
        const configured = (await providerCatalog(codingRoot, { signal: cliOptions.signal })).rows.find((entry) => entry.provider.id === id);
        if (!configured) throw new Error("Verification requires a configured provider; use hive providers setup first.");
        const report = await verifyProvider(configured.registry, id, { model, coding, maxOutputTokens, timeoutMs, signal: cliOptions.signal });
        const serialized = JSON.stringify(report, null, 2);
        if (output) await writeHiveRunReport(cwd, output, serialized);
        return { exitCode: report.status === "cancelled" ? 130 : report.status === "passed" ? 0 : 1,
          output: isSuppressed ? serialized : [`Provider ${id}/${report.model}: ${report.status}`, ...report.checks.map((check) => `  ${check.status.toUpperCase()} ${check.name}: ${check.detail}`), ...(output ? [`Report: ${output}`] : [])].join("\n") };
      }
      
      if (sub === "remove") {
        const id = subRest[0];
        if (!id) throw new Error("Usage: hive providers remove <provider-id>");
        const removed = await registry.remove(id);
        const outMsg = removed ? `Provider ${id} removed.` : `Provider ${id} not found.`;
        if (isSuppressed) return { exitCode: removed ? 0 : 1, output: JSON.stringify({ success: removed }) };
        return { exitCode: removed ? 0 : 1, output: outMsg };
      }
      
      if (sub === "roles") {
        if (subRest[0] === "set") {
          const role = subRest[1] as any;
          const providerId = subRest[2];
          const model = subRest[3];
          if (!role || !providerId || !model) throw new Error("Usage: hive providers roles set <role> <provider-id> <model>");
          await registry.setRole(role, providerId, model);
          return { exitCode: 0, output: isSuppressed ? JSON.stringify({ success: true }) : `Role ${role} set to ${providerId}/${model}.` };
        }
        
        const roles = await registry.getRoles();
        return { exitCode: 0, output: JSON.stringify(roles, null, 2) };
      }
      
      return { exitCode: 1, output: `Unknown providers command: ${sub}` };
    }

    if (command === "run") {
      // Need original args to parse flags correctly
      const runIndex = args.indexOf("run");
      const { prompt, options } = parseRunArgs(args.slice(runIndex + 1));
      if (!prompt) throw new Error("Task prompt is required. Usage: hive run \"<task>\"");
      
      const rolesConfig = await registry.getRoles();
      const providersList = await registry.list();
      
      if (providersList.length === 0 && !options.provider && !process.env.OPENAI_API_KEY) {
        throw new Error("No approved provider configured. Run `hive providers setup` or add a provider with `hive providers add`.");
      }

      const getSnapshot = (roleName: string, roleKey: keyof typeof rolesConfig): ProviderSnapshot => {
        const cliOverride = options[roleKey];
        if (cliOverride) {
          const [p, m] = cliOverride.split('/');
          return { role: roleName as ProviderRole, providerType: p, modelId: m || "" };
        }
        if (options.provider) {
          return { role: roleName as ProviderRole, providerType: options.provider, modelId: options.model || "" };
        }
        const roleAssigned = rolesConfig[roleKey];
        if (roleAssigned) {
          return { role: roleName as ProviderRole, providerType: roleAssigned.provider, modelId: roleAssigned.model };
        }
        return { role: roleName as ProviderRole, providerType: 'openai', modelId: 'gpt-4o' };
      };

      const providers = [
        getSnapshot('Planner', 'planner'),
        getSnapshot('Builder', 'builder'),
        getSnapshot('Validator', 'validator'),
        getSnapshot('Reviewer', 'reviewer')
      ];
      
      const taskId = `cli-${Date.now()}`;
      await setActiveTask(cwd, taskId);
      
      if (!isSuppressed) {
        const primaryProvider = providers[0];
        const runHeader = getHiveRunHeader({
          provider: primaryProvider.providerType,
          model: primaryProvider.modelId,
          mode: currentMode,
          agents: 4
        });
        if (runHeader) console.log(runHeader + "\n");
        console.log(`Starting standalone task: ${taskId}`);
        console.log(`Executing orchestration loop synchronously (Plan -> Build -> Verify -> Review)...`);
      }
      
      const executor = new StandaloneExecutor(cwd);
      const orchestrator = new CoderOrchestrator(taskId, cwd, providers, executor);
      await store.save(orchestrator.getRecord());
      
      const result = await orchestrator.runToReview(prompt);
      
      if (isSuppressed) {
        return { exitCode: 0, output: JSON.stringify(result) };
      }
      return { exitCode: 0, output: `Task reached state: ${result.state}\nRun 'hive status' or 'hive diff' to review.` };
    }
    
    if (command === "status") {
      // Check legacy active task first (backward compatibility)
      const taskId = await getActiveTaskSafe(cwd);
      if (taskId) {
        const data = await store.load(taskId);
        if (!data) throw new Error("Task data not found.");

        if (isSuppressed) {
          return { exitCode: 0, output: JSON.stringify(data) };
        }

        const nextCommands = [];
        if (data.state === 'AWAITING_APPROVAL') {
          nextCommands.push("hive diff", "hive approve");
        } else if (data.state === 'COMPLETED') {
          nextCommands.push("hive push --confirmed", "hive pr --confirmed");
        } else if (data.state === 'FAILED' || data.state === 'DISCARDED') {
          nextCommands.push("hive discard", "hive run <task>");
        } else {
          nextCommands.push("hive status (refresh)");
        }

        const output = renderStatus({
          taskId,
          mode: currentMode,
          branch: data.branchName,
          state: data.state,
          plannerState: data.plan ? "complete" : "pending",
          builderState: data.diffSummary ? "complete" : "pending",
          validatorState: data.verificationResults.length > 0 ? (data.verificationResults.every(v => v.passed) ? "passed" : "failed") : "pending",
          reviewerState: data.reviewerVerdict ? (data.reviewerVerdict.includes('REJECT') ? 'rejected' : 'approved') : "pending",
          filesChanged: data.diffSummary?.filesChanged.length || 0,
          testsPassed: data.verificationResults.length > 0 && data.verificationResults.every(v => v.passed),
          safety: currentMode,
          nextCommands
        });

        return { exitCode: 0, output };
      }

      // Fall through to coding session status
      const activeCoding = await codingStore.getActive();
      if (activeCoding) {
        if (isSuppressed) {
          return { exitCode: 0, output: JSON.stringify({
            kind: "coding",
            id: activeCoding.id,
            status: activeCoding.status,
            verdict: activeCoding.verdict,
            objective: activeCoding.objective,
          }) };
        }
        const verdict = activeCoding.verdict ?? "Not computed";
        const validation = activeCoding.validationResults ?? [];
        const failures = activeCoding.failures ?? [];
        const lines = [
          `Session: ${activeCoding.id}`,
          `Status: ${activeCoding.status}`,
          `Verdict: ${verdict}`,
          `Objective: ${activeCoding.objective}`,
          `Mode: ${activeCoding.mode}`,
          "",
          `Agents: ${activeCoding.tasks.length}`,
          `Files changed: ${activeCoding.files?.length ?? 0}`,
          `Validations: ${validation.length} (${validation.filter((v) => v.status === "passed").length} passed)`,
          `Failures: ${failures.length}`,
        ];
        if (activeCoding.finalReport?.finalSha) {
          lines.push(`Final SHA: ${activeCoding.finalReport.finalSha}`);
        }
        return { exitCode: 0, output: lines.join("\n") };
      }

      throw new Error("No active task found. Run 'hive run <task>' or 'hive code' first.");
    }
    
    if (command === "diff") {
      const taskId = await getActiveTask(cwd);
      const p = path.join(cwd, ".hivemind", "coder-tasks", taskId, "diff.patch");
      const runIndex = args.indexOf("diff");
      const { options } = parseRunArgs(args.slice(runIndex + 1));
      
      try {
        const diff = await fs.readFile(p, "utf-8");
        if (isSuppressed) {
          return { exitCode: 0, output: JSON.stringify({ diff }) };
        }

        const header = getHiveProvidersHeader() || "";
        if (options.full) {
          return { exitCode: 0, output: `${header}\n\n${diff}`.trim() || "No changes." };
        } else {
          const data = await store.load(taskId);
          const summary = data?.diffSummary;
          if (!summary) return { exitCode: 0, output: "No diff summary available." };
          const out = `${header}\n\nFiles Changed: ${summary.filesChanged.join(', ')}\nInsertions: ${summary.insertions}, Deletions: ${summary.deletions}\nRun 'hive diff --full' to see raw patch.`;
          return { exitCode: 0, output: out.trim() };
        }
      } catch (err) {
        throw new Error("No diff available yet or task not complete.");
      }
    }
    
    if (command === "approve") {
      const runIndex = args.indexOf("approve");
      const messageArgs = args.slice(runIndex + 1).filter(a => !a.startsWith('--'));
      const taskId = await getActiveTask(cwd);
      const message = messageArgs.join(" ") || "Approved via CLI";
      const record = await store.load(taskId);
      if (!record) throw new Error("Task data not found.");

      const orchestrator = await CoderOrchestrator.fromRecord(record, cwd, new StandaloneExecutor(cwd));
      await orchestrator.approve(message);

      if (isSuppressed) return { exitCode: 0, output: JSON.stringify({ success: true }) };
      const header = getHiveProvidersHeader() || "";
      return { exitCode: 0, output: `${header}\nTask ${taskId} approved.`.trim() };
    }

    if (command === "reject") {
      const selected = await codingStore.getActive();
      if (!selected) throw new Error("No active coding session.");
      return await withCodingRecord(codingRoot, selected.id, async (codingSession, lockedStore) => {
        if ((await lockedStore.getActive())?.id !== selected.id) throw new Error("The active coding session changed; retry against the current session.");
        codingSession.verdict = "REJECTED";
        codingSession.status = "failed";
        await lockedStore.save(codingSession);
        if (isSuppressed) return { exitCode: 0, output: JSON.stringify({ success: true, verdict: "REJECTED" }) };
        return { exitCode: 0, output: `Session ${codingSession.id} rejected.` };
      }, cliOptions.signal);
    }

    if (command === "discard") {
      const codingSession = await codingStore.getActive();
      if (codingSession) {
        return await withCodingRecord(codingRoot, codingSession.id, async (current, lockedStore) => {
          if ((await lockedStore.getActive())?.id !== current.id) throw new Error("The active coding session changed; retry against the current session.");
          current.status = "cancelled";
          current.cancelledAt = new Date().toISOString();
          current.cancellationReason = "Discarded by user";
          current.verdict = "BLOCKED";
          await lockedStore.save(current);
          if ((await lockedStore.getActive())?.id === current.id) await lockedStore.clearActive();
          if (isSuppressed) return { exitCode: 0, output: JSON.stringify({ success: true }) };
          return { exitCode: 0, output: `Coding session ${current.id} discarded.` };
        }, cliOptions.signal);
      }
      const taskId = await getActiveTask(cwd);
      const record = await store.load(taskId);
      if (record) {
        const orchestrator = await CoderOrchestrator.fromRecord(record, cwd, new StandaloneExecutor(cwd));
        await orchestrator.discard();
      }
      await clearActiveTask(cwd);
      if (isSuppressed) return { exitCode: 0, output: JSON.stringify({ success: true }) };
      return { exitCode: 0, output: `Task ${taskId} discarded.` };
    }
    
    if (command === "push") {
      const confirmedIndex = args.indexOf("--confirmed");
      if (confirmedIndex === -1) {
        throw new Error("Must provide --confirmed flag to push.");
      }
      const taskId = await getActiveTask(cwd);
      const owner = process.env.GITHUB_OWNER;
      const repo = process.env.GITHUB_REPO;
      const token = process.env.GITHUB_TOKEN;
      if (!owner || !repo || !token) throw new Error("GITHUB_OWNER, GITHUB_REPO, and GITHUB_TOKEN must be set.");
      
      const record = await store.load(taskId);
      if (!record) throw new Error("Task data not found.");
      
      const orchestrator = await CoderOrchestrator.fromRecord(record, cwd, new StandaloneExecutor(cwd));
      const forge = new GitHubForge(owner, repo, token);
      await orchestrator.push(forge);
      
      if (isSuppressed) return { exitCode: 0, output: JSON.stringify({ success: true }) };
      return { exitCode: 0, output: `Task ${taskId} pushed to remote.` };
    }
    
    if (command === "pr") {
      const confirmedIndex = args.indexOf("--confirmed");
      if (confirmedIndex === -1) {
        throw new Error("Must provide --confirmed flag to create PR.");
      }
      const taskId = await getActiveTask(cwd);
      const owner = process.env.GITHUB_OWNER;
      const repo = process.env.GITHUB_REPO;
      const token = process.env.GITHUB_TOKEN;
      if (!owner || !repo || !token) throw new Error("GITHUB_OWNER, GITHUB_REPO, and GITHUB_TOKEN must be set.");
      
      const record = await store.load(taskId);
      if (!record) throw new Error("Task data not found.");
      
      const orchestrator = await CoderOrchestrator.fromRecord(record, cwd, new StandaloneExecutor(cwd));
      const forge = new GitHubForge(owner, repo, token);
      const prUrl = await orchestrator.createPR(forge);
      
      if (isSuppressed) return { exitCode: 0, output: JSON.stringify({ success: true, url: prUrl }) };
      return { exitCode: 0, output: `PR created for ${taskId}.\nURL: ${prUrl}` };
    }
    
    if (command === "mode") {
      if (rest.length === 0) {
        if (isSuppressed) return { exitCode: 0, output: JSON.stringify({ mode: currentMode }) };
        return { exitCode: 0, output: `Current Mode: ${currentMode}` };
      }
      if (rest[0] === "set" && rest[1]) {
        const newMode = rest[1] as HiveMode;
        if (!["guarded", "standard", "autonomous", "plan", "review"].includes(newMode)) {
          throw new Error("Invalid mode. Choose from: guarded, standard, autonomous, plan, review");
        }
        await configStore.setMode(newMode);
        if (isSuppressed) return { exitCode: 0, output: JSON.stringify({ success: true, mode: newMode }) };
        return { exitCode: 0, output: `Mode set to: ${newMode}` };
      }
      return { exitCode: 1, output: "Usage: hive mode [set <mode>]" };
    }
    
    if (command === "sessions") {
      const sub = rest[0] ?? "list";
      const activeId = await getActiveTaskSafe(cwd);
      const activeCoding = await codingStore.getActive();
      
      if (sub === "list") {
        const tasks = await store.list();
        const codingSessions = await codingStore.list();
        if (isSuppressed) return { exitCode: 0, output: JSON.stringify([
          ...codingSessions.map((session) => ({ kind: "coding", ...session, archived: session.archived === true })),
          ...tasks.map((task) => ({ kind: "legacy", ...task, archived: task.archived === true })),
        ]) };
        if (tasks.length === 0 && codingSessions.length === 0) return { exitCode: 0, output: "No sessions found." };
        const out = [
          ...codingSessions.map((session) => `${session.id === activeCoding?.id ? '*' : ' '} ${session.id} [${sessionStateLabel(session.status, session.archived)}] - ${session.objective}`),
          ...tasks.map(t => `${t.taskId === activeId ? '*' : ' '} ${t.taskId} [${sessionStateLabel(t.state, t.archived)}] - ${t.branchName}`),
        ].join("\n");
        return { exitCode: 0, output: out };
      }
      if (sub === "show") {
        const id = rest[1];
        if (!id) throw new Error("Usage: hive sessions show <id>");
        const coding = await codingStore.load(id);
        if (coding) return { exitCode: 0, output: JSON.stringify(coding, null, 2) };
        const record = await store.load(id);
        if (!record) throw new Error(`Session ${id} not found.`);
        return { exitCode: 0, output: JSON.stringify(record, null, 2) };
      }
      if (sub === "resume") {
        const id = rest[1];
        if (!id) throw new Error("Usage: hive sessions resume <id>");
        const coding = await codingStore.load(id);
        if (coding) {
          return await withCodingRecord(codingRoot, id, async (current, lockedStore) => {
            assertSessionRestorable("coding", id, current.archived);
            await lockedStore.setActive(id);
            if (isSuppressed) return { exitCode: 0, output: JSON.stringify({ success: true, id, kind: "coding" }) };
            return { exitCode: 0, output: `Resumed coding session ${id}. Run 'hive code --resume ${id}' to continue execution.` };
          }, cliOptions.signal);
        }
        const record = await store.load(id);
        if (!record) throw new Error(`Session ${id} not found.`);
        assertSessionRestorable("legacy", id, record.archived);
        await setActiveTask(cwd, id);
        if (isSuppressed) return { exitCode: 0, output: JSON.stringify({ success: true, id }) };
        return { exitCode: 0, output: `Resumed task cell ${id}.` };
      }
      if (sub === "adopt") {
        const adoptionArgs = args.slice(args.indexOf("sessions") + 2).filter((arg) => arg !== "--json");
        const id = adoptionArgs.shift();
        let confirmed = false;
        let previewFingerprint: string | undefined;
        while (adoptionArgs.length) {
          const option = adoptionArgs.shift();
          if (option === "--confirmed" && !confirmed) confirmed = true;
          else if (option === "--fingerprint" && previewFingerprint === undefined) {
            const value = adoptionArgs.shift();
            if (!value || !/^[a-f0-9]{64}$/.test(value)) throw new Error("Adoption requires the 64-character fingerprint from its preview.");
            previewFingerprint = value;
          }
          else throw new Error("Usage: hive sessions adopt <id> [--confirmed --fingerprint <preview-hash>]");
        }
        if (!id || id.startsWith("--") || (previewFingerprint !== undefined && !/^[a-f0-9]{64}$/.test(previewFingerprint)) ||
          (confirmed !== (previewFingerprint !== undefined))) {
          throw new Error("Usage: hive sessions adopt <id> [--confirmed --fingerprint <preview-hash>]");
        }
        return await withCodingRecord(codingRoot, id, async (current) => {
          assertSessionRestorable("coding", id, current.archived);
          if (!["completed", "failed", "cancelled"].includes(current.status)) throw new Error("Workspace adoption requires a settled coding run.");
          const workspace = current.repository.worktreePath;
          const savedFingerprint = current.repository.worktreeFingerprint;
          if (!workspace || !savedFingerprint) throw new Error("Workspace adoption requires a managed worktree with a saved fingerprint.");
          const inspected = await inspectManagedWorktree(codingRoot, id, workspace);
          const changed = inspected.fingerprint !== savedFingerprint;
          if (confirmed) {
            if (previewFingerprint !== inspected.fingerprint) throw new Error("Workspace changed since adoption preview; inspect it again before confirming.");
            await recordUserWorkspaceChange(codingRoot, id, savedFingerprint, previewFingerprint);
          }
          const result = { success: true, kind: "coding", id, adopted: confirmed && changed, changed,
            worktreePath: workspace, savedFingerprint, fingerprint: inspected.fingerprint,
            ...(confirmed ? {} : { confirmCommand: `hive sessions adopt ${id} --confirmed --fingerprint ${inspected.fingerprint}` }) };
          if (isSuppressed) return { exitCode: 0, output: JSON.stringify(result) };
          return { exitCode: 0, output: confirmed
            ? changed ? `Adopted the inspected workspace for ${id}. Previous validation and review are stale; start a new turn to revalidate.`
              : `Workspace ${id} already matches its saved fingerprint.`
            : `Workspace: ${workspace}\nSaved fingerprint: ${savedFingerprint}\nCurrent fingerprint: ${inspected.fingerprint}\n${changed
              ? `Inspect the workspace files before adopting them. Adoption leaves files unchanged and invalidates prior validation and review.\nConfirm: ${result.confirmCommand}`
              : "Workspace matches its saved fingerprint; no adoption is needed."}` };
        }, cliOptions.signal);
      }
      if (sub === "fork") {
        const id = rest[1];
        if (!id) throw new Error("Usage: hive sessions fork <id>");
        const coding = await codingStore.load(id);
        if (coding) {
          const forked = await forkCodingSession(codingRoot, id, { signal: cliOptions.signal });
          if (isSuppressed) return { exitCode: 0, output: JSON.stringify({ success: true, kind: "coding", sourceId: id, id: forked.id, worktreePath: forked.repository.worktreePath }) };
          return { exitCode: 0, output: `Forked coding session ${id} to ${forked.id}.${forked.repository.worktreePath ? ` Independent workspace: ${forked.repository.worktreePath}` : ""}` };
        }
        const legacy = await store.load(id);
        if (!legacy) throw new Error(`Session ${id} not found.`);
        const forked = await store.fork(id);
        if (isSuppressed) return { exitCode: 0, output: JSON.stringify({ success: true, kind: "legacy", sourceId: id, id: forked.taskId }) };
        return { exitCode: 0, output: `Forked task cell ${id} to ${forked.taskId}.` };
      }
      if (sub === "archive" || sub === "unarchive") {
        const id = rest[1];
        if (!id) throw new Error(`Usage: hive sessions ${sub} <id>`);
        const restoring = sub === "unarchive";
        const coding = await codingStore.load(id);
        if (coding) {
          return await withCodingRecord(codingRoot, id, async (current, lockedStore) => {
            const already = restoring ? !current.archived : current.archived === true;
            if (!already) {
              if (restoring) await lockedStore.unarchive(id);
              else await lockedStore.archive(id);
            }
            if (!restoring && (await lockedStore.getActive())?.id === id) await lockedStore.clearActive();
            return archiveResult("coding", id, !restoring, already, isSuppressed);
          }, cliOptions.signal);
        }
        const legacy = await store.load(id);
        if (!legacy) throw new Error(`Session ${id} not found.`);
        const already = restoring ? !legacy.archived : legacy.archived === true;
        if (!already) {
          if (restoring) await store.unarchive(id);
          else await store.archive(id);
        }
        if (!restoring && activeId === id) await clearActiveTask(cwd);
        return archiveResult("legacy", id, !restoring, already, isSuppressed);
      }
      return { exitCode: 1, output: `Unknown sessions command: ${sub}` };
    }
    
    if (command === "scout") {
      const scoutIndex = args.indexOf("scout");
      const { options } = parseRunArgs(args.slice(scoutIndex + 1));
      
      const { generateContextPack, formatScoutText } = await import('./scout/index.js');
      const pack = await generateContextPack(cwd, options.task);
      
      if (options.json) {
        return { exitCode: 0, output: JSON.stringify(pack, null, 2) };
      }
      
      if (options.files) {
        const fileList = pack.importantFiles.map(f => {
          const score = f.priorityScore.toString().padStart(3, ' ');
          return `[${score}] ${f.path} (${f.language})`;
        }).join('\n');
        return { exitCode: 0, output: fileList || "No important files found." };
      }
      
      return { exitCode: 0, output: formatScoutText(pack) };
    }

    if (command === "chat") {
      const { runChat } = await import("./chat/chat-cli.js");
      const chatArgs = args.slice(1);
      // Extract and forward --resume <id> via ChatOptions.resumeSessionId.
      // The remaining flags (--role/--json/--agent/--model) are parsed inside
      // runChat via its own argument parser, so they pass through untouched.
      let resumeSessionId: string | undefined;
      const forwarded: string[] = [];
      for (let i = 0; i < chatArgs.length; i += 1) {
        if (chatArgs[i] === "--resume") {
          const value = chatArgs[i + 1];
          if (value !== undefined && !value.startsWith("--")) {
            resumeSessionId = value;
            i += 1;
            continue;
          }
        }
        forwarded.push(chatArgs[i]);
      }
      return await runChat(forwarded, { cwd, signal: cliOptions.signal, resumeSessionId });
    }

    if (command === "hivebot") {
      const { runHivebot } = await import("./chat/hivebot.js");
      const hivebotIndex = args.indexOf("hivebot");
      const hivebotArgs = args.slice(hivebotIndex + 1);

      // Parse --preset/--provider/--model out of the raw args; everything else
      // joins the delegated task text.
      let preset: "quick" | "standard" | "deep" | "audit" | undefined;
      let providerId: string | undefined;
      let model: string | undefined;
      const taskParts: string[] = [];
      for (let i = 0; i < hivebotArgs.length; i += 1) {
        const arg = hivebotArgs[i];
        const peek = (): string | undefined => {
          const v = hivebotArgs[i + 1];
          return v !== undefined && !v.startsWith("--") ? v : undefined;
        };
        if (arg === "--preset") {
          const v = peek();
          if (v !== undefined) {
            if (!["quick", "standard", "deep", "audit"].includes(v)) {
              return {
                exitCode: 1,
                output: `Invalid hivebot preset '${v}'. Choose from: quick, standard, deep, audit`,
              };
            }
            preset = v as "quick" | "standard" | "deep" | "audit";
            i += 1;
          }
        } else if (arg === "--provider") {
          const v = peek();
          if (v !== undefined) {
            providerId = v;
            i += 1;
          }
        } else if (arg === "--model") {
          const v = peek();
          if (v !== undefined) {
            model = v;
            i += 1;
          }
        } else {
          taskParts.push(arg);
        }
      }

      const task = taskParts.join(" ");
      return await runHivebot(task, {
        cwd,
        signal: cliOptions.signal,
        preset,
        providerId,
        model,
      });
    }

    return { exitCode: 1, output: `Unknown command: ${command}` };
    
  } catch (err: any) {
    const exitCode = cliOptions.signal?.aborted || err?.name === "AbortError" ? 130 : 1;
    if (isSuppressed) {
      return { exitCode, output: JSON.stringify({ error: err.message }) };
    }
    return { exitCode, output: err.message };
  }
}
