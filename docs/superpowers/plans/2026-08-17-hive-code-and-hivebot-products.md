# Hive Code + HiveBot Product Surfaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn HIVE's two desktop surfaces into two named products — **Hive Code** (the verified agentic coding harness, the Claude Code / Codex analog) and **HiveBot** fronting **HiveChat** (the conversational assistant, the Claude / ChatGPT analog) — by giving HiveBot a real read-only agentic mode and a one-click bridge that hands an answer to Hive Code as a verified run.

**Architecture:** HIVE already has both engines. The CLI chat REPL has an agentic mode (`/agent on`) built on `StructuredAgentLoop` + a read-only tool executor, but it lives only in `src/chat/chat-cli.ts` and the desktop `DesktopChatService` never calls it. The verified harness (Queen orchestrator, worktree isolation, approval rails) is reachable only from the Coder view. This plan (1) extracts the CLI agentic turn into a shared module, (2) wires it into `DesktopChatService` behind an `agent` flag with live tool-activity events, (3) adds a `coder.handoff` command that turns an assistant answer into a coder thread + run, and (4) brands both surfaces with the product names from the brand kit. Everything is ADDITIVE: no existing command, event, or coder behavior changes shape.

**Tech Stack:** TypeScript (Node ≥22.12), React 18 + hand-rolled CSS renderer, Electron IPC with strict contract validation, `node:test` core tests against `dist/`, Vitest + jsdom renderer tests. Zero new runtime dependencies.

## Global Constraints

- **Zero new runtime dependencies.** Reuse the hand-rolled markdown renderer (`desktop/renderer/src/markdown.tsx`), the existing `StructuredAgentLoop` (`src/coding/agent-loop.ts`), and `createReadOnlyToolExecutor` (`src/chat/agent-tools.ts`). Do not add react-markdown/shadcn/ai-elements or any agent framework.
- **Brand contract: `hive-brand-kit.json`.** Void Black `#08080B` / Hive Surface `#0F0B1A` backgrounds, Deep/Vivid/Neon Violet accents (`#5B21B6`/`#7C3AED`/`#8B5CF6`), Verified Green `#22C55E` only for success. ASCII-safe glyphs only — no emoji, no Unicode box-drawing without an ASCII fallback; the streaming caret and any tool chip are CSS/text elements, not glyphs. Product names render as **Hive Code** (harness) and **HiveBot** (chat assistant) / **HiveChat** (chat surface). Terminal rules: no emoji, respect `NO_COLOR`/non-TTY, suppress branding for `--json`.
- **Every animation behind `@media (prefers-reduced-motion: no-preference)`** or killed by the existing reduce block.
- **Accessibility:** the chat stream stays `role="log" aria-live="polite"`; the tool-activity strip gets a label; the handoff confirmation is keyboard-navigable; receipts stay truthful — never fabricate token numbers.
- **Protocol discipline:** every new command/event shape gets strict validation in `src/desktop/electron/contracts.ts` and (for commands) registration in `src/desktop/electron/command-manifest.ts`. All additions are ADDITIVE.
- **BYOK/secret discipline:** the chat service resolves providers through `ChatEngine`/`ProviderRouter` exactly like the CLI; secrets never cross IPC; role slugs accept kebab-case AND camelCase via `normalizeChatRole` (`src/chat/roles.ts`).
- **Agentic safety:** the HiveBot agentic mode is READ-ONLY. It uses `createReadOnlyToolExecutor` (read_file/list_files/search_files) and MUST NOT gain write/exec tools in this plan. Write-capable work stays the exclusive domain of the Hive Code harness behind its approval rails.
- **Core tests:** `.mjs` under `tests/`, run `npx tsc` first, import `../dist/...`. Renderer tests: Vitest + jsdom, co-located `*.test.tsx`.
- **Streaming/tool events are HIGH-FREQUENCY:** text chunks already batch at ~60 ms / 2 KB in the service; tool events are low-volume (≤24 tool calls per turn) and may be emitted directly.
- **Windows, git-bash. Platform-neutral code. YAGNI per task.**

---

## Task 0: Baseline gate

The chat+coder-windows plan is fully committed on `feat/chat-cockpit`. Before starting, confirm the tree is green so regressions are attributable to this plan.

- [ ] **Step 1: Confirm a clean, green baseline**

Run:
```bash
cd /c/HIVE
git status --short
npm run lint
npm test
```
Expected: `npm run lint` exits 0; `npm test` ends with `ℹ fail 0` (408 pass at time of writing). If unrelated files are dirty, leave them untouched; do not commit them in this plan's task commits.

**In-flight work warning:** at the time of writing, the working tree carries an uncommitted ChatGPT-style composer/welcome redesign (changes to `ChatComposer.tsx`, `Welcome.tsx`, `SessionRail.tsx`, `styles.css`, `App.tsx`, icon assets, `package.json`). This plan edits several of the same files. Before starting, either commit that redesign as its own commit (recommended, so this plan's commits stay reviewable) or confirm with the user that it should be carried. Do not silently discard it.

- [ ] **Step 2: Create the working branch if not already on it**

Run:
```bash
git branch --show-current
```
Expected: `feat/chat-cockpit`. If a fresh branch is preferred, `git switch -c feat/hive-products` from the current HEAD. All task commits land on this branch.

---

## Task 1: Product identity layer (brand kit)

Establish the two product names everywhere a user sees them: the brand kit, desktop window titles, the mode switch, the chat welcome surface, and the docs. This is cosmetic but it is the "stick to the brand kit" spine of the plan.

**Files:**
- Modify: `hive-brand-kit.json` (add a `products` block)
- Modify: `src/desktop/electron/main.ts:145` (window titles)
- Modify: `desktop/renderer/src/components/ModeSwitch.tsx:9-12` (tab labels)
- Modify: `desktop/renderer/src/components/chat/Welcome.tsx` (wordmark)
- Modify: `README.md` (rename the desktop section), `docs/HIVE_ROADMAP.md` (mark the phase)
- Test: `desktop/renderer/src/components/ModeSwitch.test.tsx`, `desktop/renderer/src/App.test.tsx` (update label assertions)

**Interfaces:**
- Consumes: nothing new.
- Produces: the canonical labels `Hive Code` and `HiveBot` used by every later task's copy.

- [ ] **Step 1: Add the `products` block to the brand kit**

In `hive-brand-kit.json`, insert a new top-level `products` object immediately after the `brand` object (keep the file valid JSON):

```json
  "products": {
    "hive_code": {
      "name": "Hive Code",
      "role": "Verified agentic coding harness (Claude Code / Codex analog)",
      "surface": "hive code CLI + TUI, and the Coder desktop view",
      "wordmark_case": "title case, never all-caps",
      "copy": "Plan, build, validate, and review changes in isolated worktrees with approve-before-commit rails."
    },
    "hivebot": {
      "name": "HiveBot",
      "role": "Conversational assistant (Claude / ChatGPT analog)",
      "surface": "hive chat / hive hivebot CLI, and the HiveChat desktop view",
      "wordmark_case": "HiveBot is one word, capital H and B",
      "copy": "Chat with BYOK personas, ground answers with read-only repo tools, and hand real work to Hive Code."
    },
    "hivechat": {
      "name": "HiveChat",
      "role": "The chat surface fronted by HiveBot",
      "surface": "desktop Chat view",
      "wordmark_case": "HiveChat is one word, capital H and C"
    }
  },
```

- [ ] **Step 2: Update desktop window titles**

In `src/desktop/electron/main.ts`, change the title expression (currently `title: view === "coder" ? "HIVE Coder" : "HIVE",`) to:

```ts
      title: view === "coder" ? "Hive Code" : "HiveBot",
```

- [ ] **Step 3: Update the mode switch labels**

In `desktop/renderer/src/components/ModeSwitch.tsx`, replace the `CELLS` array:

```ts
const CELLS: { id: DesktopMode; label: string; hint: string }[] = [
  { id: "chat", label: "HiveBot", hint: "Ctrl+Shift+1" },
  { id: "coder", label: "Hive Code", hint: "Ctrl+Shift+2" },
];
```

- [ ] **Step 4: Update the chat welcome wordmark**

In `desktop/renderer/src/components/chat/Welcome.tsx`, change the wordmark line (currently `<span className="welcome-title gpt-wordmark">HIVE Chat</span>`) to:

```tsx
          <span className="welcome-title gpt-wordmark">HiveBot</span>
```

- [ ] **Step 5: Update the affected renderer test assertions**

In `desktop/renderer/src/components/ModeSwitch.test.tsx`, update the tab queries to the new labels:

```ts
    const chat = screen.getByRole("tab", { name: /hivebot/i });
    expect(chat).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("tab", { name: /hive code/i })).toHaveAttribute("aria-selected", "true");
```

In `desktop/renderer/src/App.test.tsx`, update every assertion that references the old labels. There are four: the chat-mode switch (currently `await user.click(screen.getByRole("tab", { name: /^chat$/i }));`), the welcome wordmark check (currently `expect(screen.getByText("HIVE Chat")).toBeInTheDocument();`), and the switch-back pair (currently `await user.click(screen.getByRole("tab", { name: /^coder$/i }));` and `expect(screen.queryByText("HIVE Chat")).not.toBeInTheDocument();`). Change them to:

```ts
    await user.click(screen.getByRole("tab", { name: /^hivebot$/i }));
    // ...
    expect(screen.getByText("HiveBot")).toBeInTheDocument();
    // ...
    await user.click(screen.getByRole("tab", { name: /^hive code$/i }));
    expect(await screen.findByRole("button", { name: /Desktop companion/i })).toBeInTheDocument();
    expect(screen.queryByText("HiveBot")).not.toBeInTheDocument();
```

- [ ] **Step 6: Run renderer tests to verify they pass**

Run: `npm run typecheck:desktop-renderer && npm run test:desktop-renderer`
Expected: PASS (label assertions match the new copy).

- [ ] **Step 7: Update README and roadmap copy**

In `README.md`, rename the section header `## Windows Desktop: Chat & Coder` to `## Windows Desktop: HiveBot Chat & Hive Code`, and update the two lead sentences to name the products:

```markdown
**HiveBot** (HiveChat) is the primary, Claude/ChatGPT-parity conversational surface:
```
```markdown
**Hive Code** is the verified harness cockpit (unchanged in function, now poppable into its own OS window):
```

In `docs/HIVE_ROADMAP.md`, under "Completed Phases", add a bullet after the Desktop Chat & Coder entry:

```markdown
- **Hive Code + HiveBot Product Surfaces (2026-08-17):** dual-product identity —
  HiveBot gains a read-only agentic mode with a live tool-activity feed, and a
  one-click handoff that turns a chat answer into a verified Hive Code run.
```

- [ ] **Step 8: Commit**

```bash
git add hive-brand-kit.json src/desktop/electron/main.ts \
  desktop/renderer/src/components/ModeSwitch.tsx \
  desktop/renderer/src/components/ModeSwitch.test.tsx \
  desktop/renderer/src/components/chat/Welcome.tsx \
  desktop/renderer/src/App.test.tsx README.md docs/HIVE_ROADMAP.md
git commit -m "feat(brand): name the two product surfaces — Hive Code and HiveBot"
```

---

## Task 2: Bridge protocol — agent flag, tool event, handoff command (core)

Add the wire shapes: an `agent` flag on `chat.send`, a `chat.tool` event for live tool activity, and a `coder.handoff` command + `coder.handoff.started` event. Contracts validate both directions; the manifest registers the new command.

**Files:**
- Modify: `src/chat/types.ts` (add `DesktopChatToolActivity` DTO)
- Modify: `src/desktop/types.ts` (command + event union members)
- Modify: `src/desktop/electron/contracts.ts` (validators)
- Modify: `src/desktop/electron/command-manifest.ts` (register `coder.handoff`)
- Test: `tests/desktop-chat-protocol.test.mjs` (extend)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `DesktopChatToolActivity { name: string; label: string }`
  - `chat.send` input gains optional `agent?: boolean`
  - Event `chat.tool { conversationId, turnId, seq, tool: DesktopChatToolActivity }`
  - Command `coder.handoff { input: { conversationId, sourceMessageId, objective? } }`
  - Event `coder.handoff.started { conversationId, threadId, userMessageId }`

- [ ] **Step 1: Write the failing protocol tests**

Append to `tests/desktop-chat-protocol.test.mjs` (it already imports the contract validators from `../dist/desktop/electron/contracts.js`; reuse that import):

```js
test("chat.send accepts an agent flag and rejects non-boolean agent", () => {
  const base = { requestId: "r-1", type: "chat.send", input: { conversationId: "chat-1789200000000-ab12", content: "look", agent: true } };
  assert.doesNotThrow(() => validateDesktopCommand(base));
  assert.throws(() => validateDesktopCommand({ ...base, input: { ...base.input, agent: "yes" } }));
});

test("chat.tool event validates and rejects bad seq or tool shape", () => {
  const ok = { type: "chat.tool", timestamp: now, conversationId: "chat-1789200000000-ab12", turnId: "turn-a-1", seq: 0, tool: { name: "read_file", label: "read src/foo.ts" } };
  assert.doesNotThrow(() => validateDesktopEvent(ok));
  assert.throws(() => validateDesktopEvent({ ...ok, seq: -1 }));
  assert.throws(() => validateDesktopEvent({ ...ok, tool: { name: "read_file" } }));
});

test("coder.handoff command validates and rejects unknown fields", () => {
  const ok = { requestId: "r-2", type: "coder.handoff", input: { conversationId: "chat-1789200000000-ab12", sourceMessageId: "msg-1" } };
  assert.doesNotThrow(() => validateDesktopCommand(ok));
  assert.throws(() => validateDesktopCommand({ ...ok, input: { ...ok.input, extra: 1 } }));
  assert.throws(() => validateDesktopCommand({ requestId: "r-3", type: "coder.handoff", input: { conversationId: "nope", sourceMessageId: "msg-1" } }));
});

test("coder.handoff.started event validates", () => {
  const ok = { type: "coder.handoff.started", timestamp: now, conversationId: "chat-1789200000000-ab12", threadId: "thread-1", userMessageId: "message-1" };
  assert.doesNotThrow(() => validateDesktopEvent(ok));
  assert.throws(() => validateDesktopEvent({ ...ok, threadId: "" }));
});
```

(`now` is the ISO constant already defined near the top of this test file; if absent, add `const now = "2026-08-17T00:00:00.000Z";`.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsc && node --test --test-reporter=spec tests/desktop-chat-protocol.test.mjs`
Expected: the four new tests FAIL (`Unsupported desktop command type` / `Unsupported desktop event type`).

- [ ] **Step 3: Add the DTO to `src/chat/types.ts`**

Append after the `DesktopChatConversation` interface:

```ts
/** One agentic tool activity crossing the desktop IPC boundary. */
export interface DesktopChatToolActivity {
  name: string;
  label: string;
}
```

- [ ] **Step 4: Extend the command and event unions in `src/desktop/types.ts`**

Update the `DesktopChatConversation` import line to also bring in the new DTO:

```ts
import type {
  DesktopChatConversation,
  DesktopChatMessage,
  DesktopChatSummary,
  DesktopChatToolActivity,
  ChatReceipt,
} from "../chat/types.js";

export type { DesktopChatConversation, DesktopChatMessage, DesktopChatSummary, DesktopChatToolActivity };
```

In the `chat.send` union member, add `agent?: boolean;` to the `input` object (after `ground?: boolean;`).

Add a new command member just before the `council.start` member:

```ts
  | (DesktopCommandBase & {
      type: "coder.handoff";
      input: { conversationId: string; sourceMessageId: string; objective?: string };
    })
```

Add two event members just before the `council.started` member:

```ts
  | (DesktopEventBase & {
      type: "chat.tool";
      conversationId: string;
      turnId: string;
      seq: number;
      tool: DesktopChatToolActivity;
    })
  | (DesktopEventBase & {
      type: "coder.handoff.started";
      conversationId: string;
      threadId: string;
      userMessageId: string;
    })
```

- [ ] **Step 5: Register the command in `command-manifest.ts`**

In `DESKTOP_COMMAND_TYPES`, add `"coder.handoff"` right after `"chat.cancel"`:

```ts
  "chat.list", "chat.create", "chat.load", "chat.archive", "chat.route", "chat.send", "chat.cancel",
  "coder.handoff",
  "council.start", "council.cancel", "shell.open-view", "shell.close-view"
```

- [ ] **Step 6: Add the validators in `contracts.ts`**

In the `chat.send` command case, extend the optional field list and add the boolean check:

```ts
      const input = optionalExact(root.input, ["conversationId", "content"], ["role", "providerId", "model", "ground", "agent"], "chat send input");
      chatConversationId(input.conversationId, "chat conversation id");
      string(input.content, "chat send content", MAX_CHAT_CONTENT_CHARS);
      if (input.role !== undefined) chatRole(input.role, "chat send role");
      if (input.providerId !== undefined) providerId(input.providerId);
      if (input.model !== undefined) string(input.model, "chat send model", 256);
      if (input.ground !== undefined) boolean(input.ground, "chat send ground flag");
      if (input.agent !== undefined) boolean(input.agent, "chat send agent flag");
      break;
```

Add a new command case immediately before the `council.start` case:

```ts
    case "coder.handoff": {
      exact(root, ["requestId", "type", "input"], "desktop command");
      const input = optionalExact(root.input, ["conversationId", "sourceMessageId"], ["objective"], "coder handoff input");
      chatConversationId(input.conversationId, "chat conversation id");
      id(input.sourceMessageId, "handoff source message id");
      if (input.objective !== undefined) string(input.objective, "handoff objective", MAX_CHAT_CONTENT_CHARS);
      break;
    }
```

Add a tool validator helper next to `validateChatMessage`:

```ts
function validateChatTool(value: unknown): void {
  const tool = exact(value, ["name", "label"], "chat tool activity");
  string(tool.name, "chat tool name", 64);
  string(tool.label, "chat tool label", 300);
}
```

In `EVENT_KEYS`, add two entries (keep the record typed as `Record<DesktopEvent["type"], readonly string[]>`):

```ts
  "chat.tool": ["type", "timestamp", "conversationId", "turnId", "seq", "tool"],
  "coder.handoff.started": ["type", "timestamp", "conversationId", "threadId", "userMessageId"],
```

In the `validateDesktopEvent` switch, add two cases near the other chat cases:

```ts
    case "chat.tool": {
      chatConversationId(candidate.conversationId, "chat conversation id");
      id(candidate.turnId, "chat turn id");
      if (!Number.isSafeInteger(candidate.seq) || Number(candidate.seq) < 0 || Number(candidate.seq) > 1_000_000) throw new Error("chat tool seq is invalid.");
      validateChatTool(candidate.tool);
      break;
    }
    case "coder.handoff.started": chatConversationId(candidate.conversationId, "chat conversation id"); id(candidate.threadId, "handoff thread id"); id(candidate.userMessageId, "handoff message id"); break;
```

- [ ] **Step 7: Run the protocol tests to verify they pass**

Run: `npx tsc && node --test --test-reporter=spec tests/desktop-chat-protocol.test.mjs`
Expected: PASS, including the four new tests.

- [ ] **Step 8: Commit**

```bash
git add src/chat/types.ts src/desktop/types.ts src/desktop/electron/contracts.ts \
  src/desktop/electron/command-manifest.ts tests/desktop-chat-protocol.test.mjs
git commit -m "feat(desktop): protocol for chat agent flag, tool events, and coder handoff"
```

---

## Task 3: Shared agentic turn module (core)

Extract the CLI's `completeAgentTurn` into a shared, injectable module so both the CLI REPL and the desktop service drive the exact same read-only agent loop. This is the DRY seam the desktop service needs.

**Files:**
- Create: `src/chat/agent-turn.ts`
- Modify: `src/chat/history.ts` (move `HISTORY_CHAR_BUDGET` here to avoid a circular import)
- Modify: `src/chat/chat-cli.ts:144,240-314` (re-export the constant; delegate to the shared module)
- Test: `tests/chat-agent-turn.test.mjs` (new)

**Interfaces:**
- Consumes: `ChatEngine.complete`, `StructuredAgentLoop`, `createReadOnlyToolExecutor`, `describeReadOnlyTools`, `compactHistory`, `HISTORY_CHAR_BUDGET`.
- Produces:
  - `runChatAgentTurn(input: ChatAgentTurnInput, hooks?: ChatAgentTurnHooks): Promise<ChatAgentTurnResult>`
  - `ChatAgentTurnInput { cwd, engine, role, message, history, override?, grounding?, signal? }`
  - `ChatAgentTurnHooks { onEvent?: (event: AgentLoopEvent) => void }`
  - `ChatAgentTurnResult { output, receipt, turns, toolCalls }`

**Circular-import note:** `agent-turn.ts` needs `HISTORY_CHAR_BUDGET`, which currently lives in `chat-cli.ts`. Since `chat-cli.ts` will import `runChatAgentTurn` from `agent-turn.ts`, leaving the constant in `chat-cli.ts` creates a cycle. Move the constant to `history.ts` (which `agent-turn.ts` already imports for `compactHistory`) and re-export it from `chat-cli.ts` so existing importers (`src/desktop/chat-service.ts`, tests) keep working unchanged.

- [ ] **Step 1: Write the failing test**

Create `tests/chat-agent-turn.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";

import { runChatAgentTurn } from "../dist/chat/agent-turn.js";

function stubEngine(scripted) {
  let call = 0;
  return {
    async complete(request) {
      const output = scripted[call] ?? scripted[scripted.length - 1];
      call += 1;
      return { output, receipt: { role: "coding", providerId: "stub", model: "stub-1", degraded: false, promptTokens: 5, completionTokens: 7, totalTokens: 12 } };
    },
    async resolveRoute() { return { providerId: "stub", model: "stub-1", source: "test", degraded: false }; },
  };
}

test("runChatAgentTurn runs the loop, surfaces tool events, and returns the summary", async () => {
  const events = [];
  const engine = stubEngine([
    JSON.stringify({ done: false, toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "README.md" } }] }),
    JSON.stringify({ done: true, summary: "Read the readme." }),
  ]);
  const result = await runChatAgentTurn(
    { cwd: process.cwd(), engine, role: "coding", message: "what does the readme say", history: [] },
    { onEvent: (event) => events.push(event) },
  );
  assert.equal(result.output, "Read the readme.");
  assert.equal(result.receipt.providerId, "stub");
  assert.ok(events.some((e) => e.type === "subagent.tool_call"));
  assert.ok(result.toolCalls >= 1);
});

test("runChatAgentTurn returns a degraded-free fallback receipt when the engine gives none", async () => {
  const engine = {
    async complete() { return { output: JSON.stringify({ done: true, summary: "done" }), receipt: { role: "coding", providerId: "", model: "" } }; },
    async resolveRoute() { return { providerId: "", model: "", source: "test", degraded: false }; },
  };
  const result = await runChatAgentTurn({ cwd: process.cwd(), engine, role: "coding", message: "hi", history: [] });
  assert.equal(result.output, "done");
  assert.equal(result.receipt.degraded, false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsc && node --test --test-reporter=spec tests/chat-agent-turn.test.mjs`
Expected: FAIL with `Cannot find module ../dist/chat/agent-turn.js`.

- [ ] **Step 3: Move `HISTORY_CHAR_BUDGET` to `history.ts`**

In `src/chat/history.ts`, add the constant near the top (after the imports):

```ts
/** Rough per-turn budget for history that is sent to the model. */
export const HISTORY_CHAR_BUDGET = 48_000;
```

In `src/chat/chat-cli.ts`, replace the local declaration (currently `export const HISTORY_CHAR_BUDGET = 48_000;` at line ~144) with a re-export so existing importers are unaffected:

```ts
import { compactHistory, HISTORY_CHAR_BUDGET } from "./history.js";
export { HISTORY_CHAR_BUDGET };
```

(Merge the `compactHistory` import with the file's existing `import { compactHistory } from "./history.js";` if present, so there is a single import statement.)

- [ ] **Step 4: Create `src/chat/agent-turn.ts`**

```ts
import type { ChatEngine } from "./engine.js";
import type { ChatMessage, ChatReceipt } from "./types.js";
import { CHAT_ROLE_META, normalizeChatRole, type ChatRoleSlug } from "./roles.js";
import type { ChatBindingRole, SubagentTask } from "../coding/types.js";
import { StructuredAgentLoop, type AgentCompletionClient, type AgentLoopEvent } from "../coding/agent-loop.js";
import { createReadOnlyToolExecutor, describeReadOnlyTools } from "./agent-tools.js";
import { compactHistory, HISTORY_CHAR_BUDGET } from "./history.js";

export interface ChatAgentTurnInput {
  cwd: string;
  engine: ChatEngine;
  role: ChatRoleSlug;
  message: string;
  history: ChatMessage[];
  override?: { providerId?: string; model?: string };
  grounding?: string;
  signal?: AbortSignal;
}

export interface ChatAgentTurnHooks {
  /** Mirrors StructuredAgentLoop events (tool calls + progress) for live UI feeds. */
  onEvent?: (event: AgentLoopEvent) => void;
}

export interface ChatAgentTurnResult {
  output: string;
  receipt: ChatReceipt;
  turns: number;
  toolCalls: number;
}

function slugToBinding(slug: ChatRoleSlug): ChatBindingRole {
  return normalizeChatRole(slug) ?? "coding";
}

function renderHistory(history: ChatMessage[]): string {
  return history
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n\n");
}

function systemPromptFor(role: ChatRoleSlug, grounding?: string): string {
  const persona = CHAT_ROLE_META[role].systemPrompt;
  return grounding ? `${grounding}\n\n---\n\n${persona}` : persona;
}

/**
 * Agentic chat turn driven by StructuredAgentLoop with the READ-ONLY tool
 * executor. Shared by the CLI REPL (`/agent on`) and the desktop chat service
 * so both surfaces behave identically. Never grants write or exec tools.
 */
export async function runChatAgentTurn(
  input: ChatAgentTurnInput,
  hooks: ChatAgentTurnHooks = {},
): Promise<ChatAgentTurnResult> {
  const binding = slugToBinding(input.role);
  const persona = systemPromptFor(input.role, input.grounding);
  const toolsDesc = describeReadOnlyTools();

  let lastReceipt: ChatReceipt | undefined;
  const completionClient: AgentCompletionClient = {
    complete(request) {
      const systemPrompt = [
        persona,
        toolsDesc,
        "You may use tools to ground answers; you cannot modify anything.",
        'Return exactly one JSON object per turn: {"done":false,"toolCalls":[{"id":"call-1","name":"read_file","arguments":{"path":"src/foo.ts"}}]}',
        'or {"done":true,"summary":"..."}.',
      ].join("\n");
      return input.engine
        .complete({
          role: binding,
          prompt: request.prompt,
          systemPrompt,
          providerId: request.providerId || input.override?.providerId,
          model: request.model || input.override?.model,
          signal: request.signal ?? input.signal,
        })
        .then((result) => {
          lastReceipt = result.receipt;
          return {
            output: result.output,
            usage: {
              input: result.receipt.promptTokens,
              output: result.receipt.completionTokens,
              total: result.receipt.totalTokens,
            },
          };
        });
    },
  };

  const task: SubagentTask = {
    id: `chat-${Date.now()}`,
    sessionId: "",
    role: "scout",
    title: input.message,
    objective: input.message,
    status: "created",
    providerId: input.override?.providerId ?? "",
    model: input.override?.model,
    dependencies: [],
    fileScope: [],
    expectedOutput: input.message,
    completionCriteria: [],
    validationCommands: [],
    depth: 0,
    attempt: 1,
    maxAttempts: 1,
    createdAt: new Date().toISOString(),
  };

  const loop = new StructuredAgentLoop();
  const result = await loop.run({
    task,
    cwd: input.cwd,
    sharedContext: renderHistory(compactHistory(input.history, HISTORY_CHAR_BUDGET).kept),
    completionClient,
    tools: createReadOnlyToolExecutor(input.cwd),
    signal: input.signal ?? new AbortController().signal,
    onEvent: hooks.onEvent,
    maxTurns: 8,
    maxToolCalls: 24,
  });

  const receipt: ChatReceipt =
    lastReceipt ?? { role: input.role, providerId: "", model: "", degraded: false };
  return { output: result.summary, receipt, turns: result.turns, toolCalls: result.toolCalls };
}
```

- [ ] **Step 5: Delegate the CLI's `completeAgentTurn` to the shared module**

In `src/chat/chat-cli.ts`, replace the body of `completeAgentTurn` (currently lines ~240-314) with:

```ts
/** Agentic turn driven by the shared read-only agent loop. */
async function completeAgentTurn(input: TurnInput): Promise<{ output: string; receipt: ChatReceipt }> {
  const result = await runChatAgentTurn({
    cwd: input.cwd ?? process.cwd(),
    engine: input.engine,
    role: input.role,
    message: input.message,
    history: input.history,
    override: input.override,
    grounding: input.grounding,
    signal: input.signal,
  });
  return { output: result.output, receipt: result.receipt };
}
```

Add the import near the other chat imports:

```ts
import { runChatAgentTurn } from "./agent-turn.js";
```

Remove imports that are now unused in `chat-cli.ts` (`StructuredAgentLoop`, `AgentCompletionClient`, `createReadOnlyToolExecutor`, `describeReadOnlyTools`, and the `SubagentTask` type if nothing else uses it). `npm run lint` will flag any leftover.

- [ ] **Step 6: Run the new test and the existing chat tests**

Run: `npx tsc && node --test --test-reporter=spec tests/chat-agent-turn.test.mjs tests/chat-core.test.mjs tests/chat-engine.test.mjs`
Expected: PASS. The CLI behavior is byte-identical because the extracted body is the same.

Also register the new file in the `package.json` `test` script list (append `tests/chat-agent-turn.test.mjs` after `tests/chat-core.test.mjs`) so `npm test` runs it.

- [ ] **Step 7: Commit**

```bash
git add src/chat/agent-turn.ts src/chat/history.ts src/chat/chat-cli.ts tests/chat-agent-turn.test.mjs package.json
git commit -m "refactor(chat): extract shared read-only agentic turn module"
```

---

## Task 4: DesktopChatService agentic mode (core)

Wire `runChatAgentTurn` into the desktop chat service behind the `agent` flag, emitting `chat.tool` events for live tool activity and finalizing with a truthful receipt.

**Files:**
- Modify: `src/desktop/chat-service.ts` (options seam + agent branch in `send`)
- Test: `tests/desktop-chat-service.test.mjs` (extend)

**Interfaces:**
- Consumes: `runChatAgentTurn(input, hooks)` from Task 3; the `chat.tool` event shape from Task 2.
- Produces: `DesktopChatServiceOptions.runAgentTurn?` seam; `send({ ..., agent: true })` emits `chat.started` → `chat.tool`* → `chat.changed` + `chat.completed`.

- [ ] **Step 1: Write the failing test**

Append to `tests/desktop-chat-service.test.mjs`. This file builds the service through a `fixture(engineOverrides, options)` helper (the second argument is spread into `DesktopChatServiceOptions`) and waits with an `until(predicate, label)` helper — reuse both:

```js
test("send with agent:true emits tool events then a completed message with receipt", async () => {
  const { events, service } = await fixture({}, {
    runAgentTurn: async (input, hooks) => {
      hooks.onEvent?.({ type: "subagent.tool_call", subagentId: "chat-1", payload: { callId: "c1", name: "read_file", arguments: { path: "src/foo.ts" } } });
      return { output: "I read the file.", receipt: { role: "coding", providerId: "stub-provider", model: "stub-model", degraded: false, totalTokens: 10 }, turns: 2, toolCalls: 1 };
    },
  });
  const conversation = await service.create({});
  await service.send({ conversationId: conversation.id, content: "read foo", agent: true });
  await until(() => events.some((event) => event.type === "chat.completed"), "chat.completed");

  const tool = events.find((event) => event.type === "chat.tool");
  assert.equal(tool.tool.name, "read_file");
  assert.equal(tool.tool.label, "read src/foo.ts");
  const completed = events.find((event) => event.type === "chat.completed");
  assert.equal(completed.message.content, "I read the file.");
  assert.equal(completed.message.receipt.totalTokens, 10);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsc && node --test --test-reporter=spec tests/desktop-chat-service.test.mjs`
Expected: the new test FAILS (`runAgentTurn` is not a known option; no `chat.tool` emitted).

- [ ] **Step 3: Add the seam and agent branch to `chat-service.ts`**

Add imports:

```ts
import { runChatAgentTurn, type ChatAgentTurnHooks, type ChatAgentTurnInput, type ChatAgentTurnResult } from "../chat/agent-turn.js";
import type { DesktopChatToolActivity } from "../chat/types.js";
```

Extend `DesktopChatServiceOptions`:

```ts
  /** Injectable agentic-turn runner for tests; defaults to runChatAgentTurn. */
  runAgentTurn?: (input: ChatAgentTurnInput, hooks: ChatAgentTurnHooks) => Promise<ChatAgentTurnResult>;
```

In the constructor, store it:

```ts
    this.#runAgentTurn = options.runAgentTurn ?? ((input, hooks) => runChatAgentTurn(input, hooks));
```

and declare the field `readonly #runAgentTurn: NonNullable<DesktopChatServiceOptions["runAgentTurn"]>;`.

Add a module-level label helper:

```ts
function labelToolCall(name: unknown, args: Record<string, unknown>): DesktopChatToolActivity {
  const toolName = typeof name === "string" ? name : "tool";
  const pathArg = typeof args.path === "string" && args.path.trim() ? args.path : undefined;
  const queryArg = typeof args.query === "string" && args.query.trim() ? args.query : undefined;
  let label = toolName;
  if (toolName === "read_file") label = `read ${pathArg ?? "file"}`;
  else if (toolName === "list_files") label = `list ${pathArg ?? "."}`;
  else if (toolName === "search_files") label = queryArg ? `search "${queryArg}"` : "search";
  return { name: toolName, label };
}
```

Extend `DesktopChatSendInput` with `agent?: boolean;`.

In `send`, after the existing `engine`/`systemPrompt`/`context`/`prompt` setup and the chunk-batching closures, replace the single `void engine.complete(...)` tail with a branch. Keep the existing non-agent path unchanged and add the agent path so both share one finalize/fail pair:

```ts
    const finalize = async (output: string, receipt: ChatReceipt): Promise<void> => {
      flush();
      const messages = [...persisted.messages, { role: "assistant" as const, content: output, at: this.#clock(), receipt }];
      const completed: ChatSessionRecord = { ...persisted, messages };
      await store.save(completed);
      const message = toMessage(messages[messages.length - 1], messages.length - 1);
      this.#emit({ type: "chat.changed", timestamp: this.#clock(), conversation: toConversation(completed) });
      this.#emit({ type: "chat.completed", timestamp: this.#clock(), conversationId: record.id, turnId, message });
    };
    const fail = async (error: unknown): Promise<void> => {
      flush();
      const message = controller.signal.aborted
        ? "Cancelled."
        : error instanceof Error ? error.message : String(error);
      this.#emit({ type: "chat.failed", timestamp: this.#clock(), conversationId: record.id, turnId, message: message.slice(0, 2_000) || "Chat turn failed.", recoverable: true });
    };
    const cleanup = (): void => {
      if (flushTimer) clearTimeout(flushTimer);
      if (this.#controllers.get(record.id) === controller) this.#controllers.delete(record.id);
    };

    if (input.agent) {
      let toolSeq = 0;
      const hooks: ChatAgentTurnHooks = {
        onEvent: (event) => {
          if (event.type !== "subagent.tool_call") return;
          const args = (event.payload.arguments ?? {}) as Record<string, unknown>;
          this.#emit({ type: "chat.tool", timestamp: this.#clock(), conversationId: record.id, turnId, seq: toolSeq, tool: labelToolCall(event.payload.name, args) });
          toolSeq += 1;
        },
      };
      void this.#runAgentTurn(
        { cwd: root, engine, role: slug, message: input.content, history: persisted.messages.slice(0, -1), override, grounding, signal: controller.signal },
        hooks,
      ).then((result) => finalize(result.output, result.receipt)).catch(fail).finally(cleanup);
      return;
    }

    void engine
      .complete({ role: slugToBinding(slug), prompt, systemPrompt, providerId: input.providerId, model: input.model, signal: controller.signal, onChunk })
      .then((result) => finalize(result.output, result.receipt))
      .catch(fail)
      .finally(cleanup);
```

(Reuse the existing `override` local already defined near the top of `send()` — `const override = input.providerId || input.model ? { providerId: input.providerId, model: input.model } : undefined;` — which the persisted record already consumes. Do not redeclare it.)

- [ ] **Step 4: Run the service tests to verify they pass**

Run: `npx tsc && node --test --test-reporter=spec tests/desktop-chat-service.test.mjs`
Expected: PASS, including the new agent test. Existing non-agent tests must stay green.

- [ ] **Step 5: Commit**

```bash
git add src/desktop/chat-service.ts tests/desktop-chat-service.test.mjs
git commit -m "feat(desktop): agentic read-only turns in the chat service with tool events"
```

---

## Task 5: Renderer — agent toggle + live tool-activity strip

Surface the agentic mode in HiveChat: an `[/agent]` composer chip, a reducer that collects `chat.tool` events, and a live tool-activity strip inside the streaming message.

**Files:**
- Modify: `desktop/renderer/src/state.ts` (streaming slice + `chat.tool` case)
- Modify: `desktop/renderer/src/components/chat/ChatComposer.tsx` (agent chip)
- Modify: `desktop/renderer/src/components/chat/ChatView.tsx` (agent state + send wiring)
- Modify: `desktop/renderer/src/components/chat/ChatStream.tsx` (tool strip)
- Modify: `desktop/renderer/src/styles.css` (tool strip styles)
- Test: `ModeSwitch.test.tsx` (reducer), `ChatComposer.test.tsx`, `ChatStream.test.tsx`

**Interfaces:**
- Consumes: `chat.tool` event (Task 2), `agent` flag on `chat.send` (Task 2).
- Produces: `ToolActivity { name, label }` in the renderer; streaming entry `{ turnId, text, tools: ToolActivity[] }`.

- [ ] **Step 1: Write the failing reducer test**

In `desktop/renderer/src/components/ModeSwitch.test.tsx`, extend the reducer test (or add a new `it`) to assert tool collection:

```ts
  it("chat.tool appends tool activity only for the matching turn", () => {
    let state = initialDesktopState();
    state = reduceDesktopEvent(state, { type: "chat.started", timestamp: now, conversationId, turnId: "turn-a-1" });
    state = reduceDesktopEvent(state, { type: "chat.tool", timestamp: now, conversationId, turnId: "turn-a-1", seq: 0, tool: { name: "read_file", label: "read src/foo.ts" } });
    state = reduceDesktopEvent(state, { type: "chat.tool", timestamp: now, conversationId, turnId: "turn-stale-9", seq: 0, tool: { name: "read_file", label: "IGNORE" } });
    expect(state.chat.streaming[conversationId]?.tools).toEqual([{ name: "read_file", label: "read src/foo.ts" }]);
  });
```

- [ ] **Step 2: Run the renderer tests to verify it fails**

Run: `npm run test:desktop-renderer`
Expected: the new test FAILS (`tools` is undefined / `chat.tool` unhandled).

- [ ] **Step 3: Extend the state slice and reducer in `state.ts`**

Add a renderer-side type near `ChatRouteInfo`:

```ts
/** One HiveBot agentic tool activity for the live strip. */
export interface ToolActivity {
  name: string;
  label: string;
}
```

Change the `streaming` field type in `DesktopChatState`:

```ts
  streaming: Record<string, { turnId: string; text: string; tools: ToolActivity[] } | undefined>;
```

Update the `chat.started` case to seed `tools: []`:

```ts
    case "chat.started": return { ...state, chat: { ...state.chat, streaming: { ...state.chat.streaming, [event.conversationId]: { turnId: event.turnId, text: "", tools: [] } }, lastFailed: null }, error: null };
```

Add a `chat.tool` case right after the `chat.chunk` case:

```ts
    case "chat.tool": {
      const stream = state.chat.streaming[event.conversationId];
      if (!stream || stream.turnId !== event.turnId) return state;
      return { ...state, chat: { ...state.chat, streaming: { ...state.chat.streaming, [event.conversationId]: { ...stream, tools: [...stream.tools, event.tool] } } } };
    }
```

(The existing `chat.chunk` case spreads `...stream`, so it already preserves `tools`.)

**Fix the pre-existing assertion this change breaks:** in `desktop/renderer/src/components/ModeSwitch.test.tsx`, the "mode action flips state and chunk appends only for the active turn" test asserts `expect(state.chat.streaming[conversationId]).toEqual({ turnId: "turn-a-1", text: "Hello " });`. Because the streaming entry now carries `tools`, update that line to:

```ts
    expect(state.chat.streaming[conversationId]).toEqual({ turnId: "turn-a-1", text: "Hello ", tools: [] });
```

- [ ] **Step 4: Add the `[/agent]` chip to `ChatComposer.tsx`**

Add two props to `ChatComposerProps`: `agent: boolean;` and `onAgentChange: (agent: boolean) => void;`. Destructure them. Insert a toggle chip immediately after the `[/ground]` chip button:

```tsx
        <button
          type="button"
          className={`composer-chip toggle${agent ? " on" : ""}`}
          aria-pressed={agent}
          aria-label="Toggle agentic mode"
          title="Let HiveBot ground answers with read-only repository tools"
          onClick={() => onAgentChange(!agent)}
        >
          [/agent{agent ? ": on" : ""}]
        </button>
```

Then update the `ChatComposer.test.tsx` harness `base` object (it is typed as `Parameters<typeof ChatComposer>[0]`, so the new required props must be present or the file will not typecheck). Add these two lines next to the `ground`/`onGroundChange` entries:

```ts
    agent: false,
    onAgentChange: vi.fn(),
```

- [ ] **Step 5: Wire agent state in `ChatView.tsx`**

Add `const [agent, setAgent] = useState(false);` next to the other composer state, and reset it in the conversation-switch `useEffect` (`setAgent(false);`). In `sendMessage`, add `agent` to the non-council `chat.send` input:

```ts
    await send({
      type: "chat.send",
      input: {
        conversationId: active.id,
        content,
        ...(roleChoice ? { role: roleChoice } : {}),
        ...(override?.providerId || override?.model ? { providerId: override.providerId, model: override.model } : {}),
        ground,
        agent,
      },
    });
```

Pass `agent={agent}` and `onAgentChange={setAgent}` to `<ChatComposer>`.

- [ ] **Step 6: Render the tool strip in `ChatStream.tsx`**

First widen the prop so isolated tests that hand-build a `streaming` object without `tools` keep compiling: in `ChatStreamProps`, change the `streaming` field to `streaming: { turnId: string; text: string; tools?: ToolActivity[] } | undefined;` and import `ToolActivity` from `../../state`. Inside the component, read it defensively with `const tools = streaming.tools ?? [];`.

Inside the streaming `<li>`, render the strip before the text/loader and only show the loader when there is neither text nor tools:

```tsx
          <div className="message-body">
            {tools.length > 0 && (
              <ul className="agent-tool-strip" aria-label="HiveBot tool activity">
                {tools.map((tool, index) => (
                  <li key={`${tool.name}-${index}`} className="agent-tool-chip anim-in">[{tool.label}]</li>
                ))}
              </ul>
            )}
            {streaming.text ? (
              <>
                {renderMarkdown(streaming.text)}
                <span className="stream-caret" aria-hidden="true" />
              </>
            ) : tools.length === 0 ? (
              <TypingLoader role={conversation.role} route={route} />
            ) : null}
          </div>
```

- [ ] **Step 7: Add the tool-strip styles to `styles.css`**

Append (brand colors, ASCII-safe). The file already defines an `.anim-in` entry animation inside a `prefers-reduced-motion: no-preference` block, so the `anim-in` class added to each chip in Step 6 is automatically motion-gated — no new keyframe is needed:

```css
.agent-tool-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  list-style: none;
  margin: 0 0 10px;
  padding: 0;
}
.agent-tool-chip {
  font-size: 12px;
  color: #A78BFA;
  background: rgba(91, 33, 182, 0.18);
  border: 1px solid rgba(139, 92, 246, 0.35);
  border-radius: 4px;
  padding: 2px 8px;
}
```

- [ ] **Step 8: Add component tests**

In `ChatComposer.test.tsx`, add (using the existing `harness` helper):

```ts
  it("toggles agentic mode via the [/agent] chip", async () => {
    const onAgentChange = vi.fn();
    const { user, view } = harness({ agent: false, onAgentChange });
    await user.click(view.getByRole("button", { name: /toggle agentic mode/i }));
    expect(onAgentChange).toHaveBeenCalledWith(true);
  });
```

In `ChatStream.test.tsx`, add (this file already imports `screen` from `@testing-library/react` but not `userEvent`, so add `import userEvent from "@testing-library/user-event";` at the top):

```ts
  it("renders the live tool-activity strip while an agent turn streams", () => {
    render(
      <ChatStream
        conversation={conversation}
        streaming={{ turnId: "turn-a-1", text: "", tools: [{ name: "read_file", label: "read src/foo.ts" }] }}
        disabled
        onRetry={() => {}}
        repositoryRoot="C:\HIVE"
        onOpenArtifacts={() => {}}
      />,
    );
    expect(screen.getByLabelText(/hivebot tool activity/i)).toBeInTheDocument();
    expect(screen.getByText("[read src/foo.ts]")).toBeInTheDocument();
  });
```

- [ ] **Step 9: Run the renderer tests to verify they pass**

Run: `npm run typecheck:desktop-renderer && npm run test:desktop-renderer`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add desktop/renderer/src/state.ts \
  desktop/renderer/src/components/chat/ChatComposer.tsx \
  desktop/renderer/src/components/chat/ChatComposer.test.tsx \
  desktop/renderer/src/components/chat/ChatView.tsx \
  desktop/renderer/src/components/chat/ChatStream.tsx \
  desktop/renderer/src/components/chat/ChatStream.test.tsx \
  desktop/renderer/src/components/ModeSwitch.test.tsx \
  desktop/renderer/src/styles.css
git commit -m "feat(desktop): HiveBot agent toggle and live tool-activity strip"
```

---

## Task 6: Chat → Hive Code handoff (router + renderer)

The signature "two products work together" feature: a **send to hive code** action on an assistant message that creates a coder thread, appends the answer as the run brief, and starts a verified Hive Code run — then jumps the user to the Coder view.

**Files:**
- Modify: `src/desktop/electron/router.ts` (new `coder.handoff` case)
- Modify: `desktop/renderer/src/components/chat/MessageActions.tsx` (action button)
- Modify: `desktop/renderer/src/components/chat/MessageList.tsx` (thread the callback)
- Modify: `desktop/renderer/src/components/chat/ChatStream.tsx` (thread the callback)
- Modify: `desktop/renderer/src/components/chat/ChatView.tsx` (confirm dialog + dispatch + notify App)
- Modify: `desktop/renderer/src/App.tsx` (handoff handler → coder mode + load thread)
- Test: `tests/desktop-electron.test.mjs` (router), renderer component tests

**Interfaces:**
- Consumes: `coder.handoff` command + `coder.handoff.started` event (Task 2); `DesktopChatService.load`; `ThreadStore.create`/`appendMessage`; `workerSupervisor.dispatchAndWait`.
- Produces: router returns `coder.handoff.started { conversationId, threadId, userMessageId }`; renderer switches to Hive Code focused on the new thread.

- [ ] **Step 1: Write the failing router test**

Append to `tests/desktop-electron.test.mjs`. The router's public entry point is `router.handle(command)`, which validates, dispatches, and converts thrown errors into `request.failed` events. Reuse the file's existing patterns (`temporaryDirectory`, `JsonDesktopAppStateStore`, the stub `credentialVault`/`workerSupervisor` shapes seen in the "main router connects repository/AppData/thread boundaries" test):

```js
test("coder.handoff creates a thread, appends the brief, and starts a run", async () => {
  const root = await temporaryDirectory("hive-handoff-");
  const appData = await temporaryDirectory("hive-handoff-state-");
  const dispatched = [];
  const threads = [];
  const threadStore = {
    async list() { return threads; },
    async create(input) { const thread = { schemaVersion: 1, id: input.id ?? `thread-${threads.length + 1}`, title: input.title, createdAt: now, updatedAt: now, archived: false, messages: [], runs: [] }; threads.push(thread); return thread; },
    async load(id) { return threads.find((thread) => thread.id === id) ?? null; },
    async save(thread) { return thread; },
    async appendMessage(id, message) { const thread = threads.find((entry) => entry.id === id); thread.messages.push(message); return thread; },
    async mutate() { throw new Error("unused"); },
    async archive() { throw new Error("unused"); },
  };
  const router = new DesktopCommandRouter({
    stateStore: new JsonDesktopAppStateStore(appData, { clock: () => now }),
    credentialVault: { async list() { return []; }, async metadata() { return null; }, async set() {}, async replace() {}, async remove() {}, async test() {} },
    workerSupervisor: { async dispatchAndWait(rootArg, command) { dispatched.push(command); }, async reconcileRepositoryRuns() {}, hasActiveRuns() { return false; }, hasActiveRepository() { return false; } },
    guardedGitFactory: () => { throw new Error("unused"); },
    threadStoreFactory: () => threadStore,
    chatService: { async load() { return { id: "chat-1789200000000-ab12", cwd: root, role: "auto", ground: false, createdAt: now, updatedAt: now, messages: [ { id: "msg-0", role: "user", content: "q", at: now }, { id: "msg-1", role: "assistant", content: "Step one. Step two.", at: now } ] }; } },
    clock: () => now,
  });
  await router.handle({ requestId: "open", type: "repository.open", repositoryRoot: root });
  const event = await router.handle({ requestId: "r-9", type: "coder.handoff", input: { conversationId: "chat-1789200000000-ab12", sourceMessageId: "msg-1" } });
  assert.equal(event.type, "coder.handoff.started");
  assert.ok(event.threadId);
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].type, "run.start");
  assert.equal(dispatched[0].input.currentUserMessageId, event.userMessageId);
  assert.equal(threads[0].messages[0].content.includes("Step one. Step two."), true);
  await rm(root, { recursive: true, force: true }); await rm(appData, { recursive: true, force: true });
});

test("coder.handoff refuses when a repository run is already active", async () => {
  const root = await temporaryDirectory("hive-handoff-busy-");
  const appData = await temporaryDirectory("hive-handoff-busy-state-");
  const router = new DesktopCommandRouter({
    stateStore: new JsonDesktopAppStateStore(appData, { clock: () => now }),
    credentialVault: { async list() { return []; }, async metadata() { return null; }, async set() {}, async replace() {}, async remove() {}, async test() {} },
    workerSupervisor: { async dispatchAndWait() {}, async reconcileRepositoryRuns() {}, hasActiveRuns() { return true; }, hasActiveRepository() { return true; } },
    guardedGitFactory: () => { throw new Error("unused"); },
    chatService: { async load() { return { id: "chat-1789200000000-ab12", cwd: root, role: "auto", ground: false, createdAt: now, updatedAt: now, messages: [] }; } },
    clock: () => now,
  });
  await router.handle({ requestId: "open", type: "repository.open", repositoryRoot: root });
  const failed = await router.handle({ requestId: "r-10", type: "coder.handoff", input: { conversationId: "chat-1789200000000-ab12", sourceMessageId: "msg-1" } });
  assert.equal(failed.type, "request.failed");
  assert.match(failed.message, /active Hive Code run/i);
  await rm(root, { recursive: true, force: true }); await rm(appData, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsc && node --test --test-concurrency=1 --test-reporter=spec tests/desktop-electron.test.mjs`
Expected: the two new tests FAIL. Because `handle()` converts validator/dispatch errors into `request.failed` events, the first test fails on `assert.equal(event.type, "coder.handoff.started")` (it receives `request.failed` with "Unsupported desktop command type: coder.handoff").

- [ ] **Step 3: Add the `coder.handoff` case to the router**

In `src/desktop/electron/router.ts`, first register the command as repository-scoped: in `handle()`, add `"coder.handoff"` to the `repositoryCommands` set (after `"chat.cancel"`).

Then add this case to `#dispatch`, just before the `council.start` case:

```ts
      case "coder.handoff": {
        const root = this.#requiredRepository();
        return this.#withRepositoryMutation(root, async () => {
          if (this.options.workerSupervisor.hasActiveRepository(root)) throw new Error("Wait for the active Hive Code run to stop before handing off another task.");
          const conversation = await this.#chatService.load(command.input.conversationId);
          const source = conversation.messages.find((message) => message.id === command.input.sourceMessageId);
          if (!source || source.role !== "assistant") throw new Error("Handoff source must be an assistant message.");
          const objective = (command.input.objective ?? source.content).trim();
          if (!objective) throw new Error("Handoff objective is empty.");
          const title = objective.replace(/\s+/g, " ").slice(0, 80);
          const thread = await this.#threads().create({ title: `HiveBot: ${title}` });
          const brief = `Implement the following plan produced by HiveBot in HiveChat:\n\n${objective}`;
          const userMessageId = `message-${Date.now().toString(36)}`;
          await this.#threads().appendMessage(thread.id, { id: userMessageId, role: "user", content: brief, createdAt: timestamp });
          const dispatch = this.options.workerSupervisor.dispatchAndWait.bind(this.options.workerSupervisor);
          await dispatch(root, { requestId: command.requestId, type: "run.start", input: { repositoryRoot: root, threadId: thread.id, currentUserMessageId: userMessageId, options: { mode: "auto", approvalPolicy: "changes" } } });
          return { type: "coder.handoff.started", timestamp, conversationId: conversation.id, threadId: thread.id, userMessageId };
        });
      }
```

- [ ] **Step 4: Run the router tests to verify they pass**

Run: `npx tsc && node --test --test-concurrency=1 --test-reporter=spec tests/desktop-electron.test.mjs`
Expected: PASS, including the two new handoff tests.

- [ ] **Step 5: Add the action button to `MessageActions.tsx`**

Extend `MessageActionsProps` with OPTIONAL props so existing call sites keep compiling: `handoffAvailable?: boolean;` and `onHandoff?: () => void;`. Render a third button after `retry`:

```tsx
      {handoffAvailable && onHandoff && (
        <button type="button" className="link-btn" disabled={disabled} onClick={onHandoff}>
          send to hive code
        </button>
      )}
```

- [ ] **Step 6: Thread the callback through `MessageList.tsx` and `ChatStream.tsx`**

In `MessageList.tsx`, add OPTIONAL props `onHandoff?: (messageId: string) => void;` and `handoffAvailable?: boolean;`, and pass into `MessageActions` for assistant messages:

```tsx
            {!isUser && (
              <MessageActions
                message={message}
                disabled={disabled}
                onRetry={() => precedingUser && onRetry(precedingUser.content)}
                retryAvailable={Boolean(precedingUser)}
                handoffAvailable={handoffAvailable}
                onHandoff={onHandoff ? () => onHandoff(message.id) : undefined}
              />
            )}
```

In `ChatStream.tsx`, add OPTIONAL props `onHandoff?: (messageId: string) => void;` and `handoffAvailable?: boolean;` to `ChatStreamProps` and forward them to `<MessageList>`. Keeping them optional means the existing `ChatStream.test.tsx` renders (which omit them) still typecheck unchanged.

- [ ] **Step 7: Add the confirm + dispatch in `ChatView.tsx`**

Add a prop `onHandoffToCoder?: (threadId: string) => void;` and local state `const [handoffPending, setHandoffPending] = useState<string | null>(null);`. Import `Dialog` from `../Dialog`. Add the handler:

```ts
  async function confirmHandoff(): Promise<void> {
    if (!active || !handoffPending) return;
    const sourceMessageId = handoffPending;
    setHandoffPending(null);
    const result = await send({ type: "coder.handoff", input: { conversationId: active.id, sourceMessageId } });
    if (result.type === "coder.handoff.started") onHandoffToCoder?.(result.threadId);
  }
```

Pass `handoffAvailable={Boolean(state.repositoryRoot)}` and `onHandoff={(messageId) => setHandoffPending(messageId)}` to `<ChatStream>`. Render the confirm dialog inside the returned tree (next to the other top-level nodes). Match the project's existing dialog button conventions (`secondary` for cancel, default styling for the confirm action, as in `ConfirmationDialog.tsx`):

```tsx
      {handoffPending && (
        <Dialog title="Send to Hive Code" onClose={() => setHandoffPending(null)}>
          <span className="eyebrow">Hive Code handoff</span>
          <p>Hand this HiveBot answer to Hive Code as a verified run? It will create a coder thread and start an isolated, approve-before-commit harness run.</p>
          <div className="dialog-actions">
            <button type="button" className="secondary" onClick={() => setHandoffPending(null)}>Cancel</button>
            <button type="button" onClick={() => void confirmHandoff()}>Send to Hive Code</button>
          </div>
        </Dialog>
      )}
```

- [ ] **Step 8: Handle the handoff in `App.tsx`**

Where `<ChatView>` is rendered, pass a handler that switches to Hive Code and loads the new thread:

```tsx
        <ChatView
          state={state}
          send={send}
          onToggleLeftRail={() => toggleRail("left")}
          onHandoffToCoder={(threadId) => {
            dispatch({ type: "ui.mode", mode: "coder" });
            updatePrefs({ mode: "coder" });
            void send({ type: "thread.load", threadId });
          }}
        />
```

- [ ] **Step 9: Add renderer tests for the handoff action**

In a chat component test (e.g. extend `ChatStream.test.tsx`), assert the button appears and fires:

```ts
  it("offers send-to-hive-code on assistant messages when a repository is open", async () => {
    const onHandoff = vi.fn();
    const withMessage = { ...conversation, messages: [ { id: "msg-0", role: "user", content: "q", at: now }, { id: "msg-1", role: "assistant", content: "answer", at: now } ] };
    render(<ChatStream conversation={withMessage} streaming={undefined} disabled={false} onRetry={() => {}} repositoryRoot="C:\HIVE" onOpenArtifacts={() => {}} handoffAvailable onHandoff={onHandoff} />);
    await userEvent.setup().click(screen.getByRole("button", { name: /send to hive code/i }));
    expect(onHandoff).toHaveBeenCalledWith("msg-1");
  });
```

- [ ] **Step 10: Run renderer + core tests**

Run: `npm run typecheck:desktop-renderer && npm run test:desktop-renderer && npx tsc && node --test --test-concurrency=1 --test-reporter=spec tests/desktop-electron.test.mjs`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add src/desktop/electron/router.ts tests/desktop-electron.test.mjs \
  desktop/renderer/src/components/chat/MessageActions.tsx \
  desktop/renderer/src/components/chat/MessageList.tsx \
  desktop/renderer/src/components/chat/ChatStream.tsx \
  desktop/renderer/src/components/chat/ChatStream.test.tsx \
  desktop/renderer/src/components/chat/ChatView.tsx \
  desktop/renderer/src/App.tsx
git commit -m "feat(desktop): hand a HiveBot answer to Hive Code as a verified run"
```

---

## Task 7: Final gate + golden-path test + docs

Prove the two-product story end-to-end in one golden path, then run the full gate and update the docs.

**Files:**
- Modify: `desktop/renderer/src/App.test.tsx` (golden path)
- Modify: `README.md`, `docs/HIVE_ROADMAP.md` (already touched in Task 1; finalize feature bullets)

**Interfaces:**
- Consumes: everything from Tasks 1–6.
- Produces: a green full gate and documented feature set.

- [ ] **Step 1: Add a standalone golden-path test to `App.test.tsx`**

Add a NEW `it(...)` inside the existing `describe("HIVE desktop cockpit", ...)` block (do not extend the existing chat golden-path test — its bridge stub asserts the exact sent content, which a second turn would break). `within` is already imported in this file. The stub handles `coder.handoff` and asserts the `agent` flag rides along on `chat.send`:

```ts
  it("hivebot agent turn streams tool activity and hands off to hive code", async () => {
    localStorage.clear();
    const conversationId = "chat-1789200000000-ab12";
    const api = bridge({
      request: async (command) => {
        if (command.type === "chat.list") return { type: "chat.listed", timestamp: now, conversations: [] };
        if (command.type === "chat.create") {
          return { type: "chat.changed", timestamp: now, conversation: { id: conversationId, cwd: "C:\\HIVE", role: "auto", ground: false, createdAt: now, updatedAt: now, messages: [] } };
        }
        if (command.type === "chat.send") {
          expect(command.input.agent).toBe(true);
          return { type: "request.completed", timestamp: now, requestId: command.requestId };
        }
        if (command.type === "coder.handoff") {
          return { type: "coder.handoff.started", timestamp: now, conversationId, threadId: "thread-handoff-1", userMessageId: "message-h1" };
        }
        return eventFor(command);
      },
    });
    const user = userEvent.setup();
    render(<App api={api} />);
    await user.click(await screen.findByRole("button", { name: /C:\\HIVE/i }));
    await screen.findByRole("button", { name: /Desktop companion/i });
    await user.click(screen.getByRole("tab", { name: /^hivebot$/i }));

    // Create a conversation, enable agentic mode, and send.
    await user.click(screen.getByRole("button", { name: /new chat/i }));
    await user.type(screen.getByLabelText(/message HIVE/i), "Read the readme");
    await user.click(screen.getByRole("button", { name: /toggle agentic mode/i }));
    await user.click(screen.getByRole("button", { name: /send message/i }));

    // Tool events render a live strip before the summary lands.
    api.emit({ type: "chat.started", timestamp: now, conversationId, turnId: "turn-agent-1" });
    api.emit({ type: "chat.tool", timestamp: now, conversationId, turnId: "turn-agent-1", seq: 0, tool: { name: "read_file", label: "read README.md" } });
    expect(await screen.findByText("[read README.md]")).toBeInTheDocument();
    api.emit({
      type: "chat.changed", timestamp: now,
      conversation: {
        id: conversationId, cwd: "C:\\HIVE", role: "auto", ground: false, createdAt: now, updatedAt: now,
        messages: [
          { id: "msg-0", role: "user", content: "Read the readme", at: now },
          { id: "msg-1", role: "assistant", content: "The readme describes HIVE.", at: now, receipt: { role: "coding", providerId: "ollama", model: "qwen3", source: "role-assignment", degraded: false, totalTokens: 30, latencyMs: 900 } },
        ],
      },
    });
    api.emit({ type: "chat.completed", timestamp: now, conversationId, turnId: "turn-agent-1", message: { id: "msg-1", role: "assistant", content: "The readme describes HIVE.", at: now, receipt: { role: "coding", providerId: "ollama", model: "qwen3", source: "role-assignment", degraded: false, totalTokens: 30, latencyMs: 900 } } });
    expect(await screen.findByText(/The readme describes HIVE\./)).toBeInTheDocument();

    // Handoff: confirm in the dialog, then land in Hive Code mode.
    await user.click(screen.getByRole("button", { name: /send to hive code/i }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /send to hive code/i }));
    expect(await screen.findByRole("tab", { name: /^hive code$/i })).toHaveAttribute("aria-selected", "true");
  });
```

(The `thread.load` dispatched after `coder.handoff.started` resolves through the default `eventFor` stub, which returns a `thread.changed` event — that is what flips the Coder view onto the new thread.)

- [ ] **Step 2: Run the golden-path test**

Run: `npm run test:desktop-renderer`
Expected: PASS.

- [ ] **Step 3: Run the full gate, in order**

Run:
```bash
npm run lint
npm run typecheck:desktop-renderer
npm run test:desktop-renderer
npm run build:desktop
npm test
```
Expected: `lint` and `typecheck` exit 0; renderer tests pass; `build:desktop` succeeds; `npm test` ends with `ℹ fail 0` and a total ≥ 408 + the new core tests. If `desktop:e2e` is supported in this environment, run `npm run desktop:e2e` as well.

- [ ] **Step 4: Regenerate the preload bundle**

The manifest gained `coder.handoff`; regenerate the preload so the renderer can dispatch it.

Run: `npm run desktop:assets`
Expected: completes without error and updates `desktop/preload.cjs`.

- [ ] **Step 5: Finalize README feature bullets**

In the renamed `## Windows Desktop: HiveBot Chat & Hive Code` section, add under the **HiveBot** bullets:

```markdown
- **Agentic mode**: `[/agent]` lets HiveBot ground answers with read-only repository tools (read/list/search) and streams a live tool-activity feed — no writes ever happen here.
- **Send to Hive Code**: any assistant answer can be handed to Hive Code as a verified, isolated, approve-before-commit run in one confirmed click.
```

- [ ] **Step 6: Manual checklist (human)**

- [ ] Real agentic chat turn over a configured provider: toggle `[/agent]`, ask about a file, watch the tool strip populate, then the summary + truthful receipt.
- [ ] Handoff: click **send to hive code** on an answer, confirm, land in Hive Code with a new thread and a running harness; verify the one-active-run guard blocks a second handoff until it finishes.
- [ ] OS reduced-motion on: zero animation; the tool strip and stream remain readable; screen reader announces the log without spam.
- [ ] Window titles show **HiveBot** and **Hive Code**; the mode switch uses the product names.

- [ ] **Step 7: Commit**

```bash
git add desktop/renderer/src/App.test.tsx README.md docs/HIVE_ROADMAP.md desktop/preload.cjs
git commit -m "test(desktop): golden path for HiveBot agent turns and Hive Code handoff; docs"
```

---

## Appendix (deferred — NOT in this plan)

- **Write-capable HiveBot tools** (file edits / commands from chat). Writes stay the exclusive domain of the Hive Code harness and its approval rails; giving chat write tools needs its own worktree-gated design.
- **HiveBot driving the full Queen council as an executable pipeline** (Forger runs via `hive code` worktrees, Sentinel verdict becomes a real gate with repair cycles). The council today produces a transcript + artifacts; wiring it to execution is a separate plan.
- **Smarter `auto` classifier** (cheap-model/embedding with confidence, learning from `/role` corrections) — still keyword-based.
- **Web version of HiveChat** (the deferred terminal-vs-web decision); desktop comes first.
- **Message search / folders / tags / export** across conversations.
