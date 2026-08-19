# HIVE Desktop Rebuild — Architecture Specification (2026-08-17)

## 1. Objective

Rebuild HIVE as a local-first Windows desktop app with **two surfaces in one window** — ChatGPT-like **Chat**, and a **Codex** workspace — sharing one kernel, one key vault, and no account.

Desktop is the primary product. The TypeScript kernel is shared across desktop IPC and future CLI invocations.

---

## 2. Locked Architecture Decisions

| Area | Specification |
| --- | --- |
| **Surfaces** | **Two surfaces, one window:** `Chat` and `Codex`. Navigation pills in the top header switch surfaces. Shared models, key vault, and settings. |
| **Writes** | **Live edits + rewind.** Modes: `Ask` / `Auto` / `YOLO`. Automatic shadow checkpoints before mutations. No auto-push. |
| **Queen / Council** | **Not default loop.** Single streaming agent is the default. Council is an explicit v1 Codex mode. |
| **RAG / Context** | **Reasonix Context Engine:** instructions (`AGENTS.md`/`HIVE.md`) + markdown facts + BM25 recall. No vector DB in v1. |
| **Providers** | **DeepSeek-first + any OpenAI-compatible.** Other wire formats after. |
| **Blast Radius** | **New kernel + new renderer.** Workbench-as-architecture and Dual Cockpit are replaced by clean `ChatSurface` and `CodexSurface`. |
| **v1 Scope** | Streaming chat, model picker, workspace tree + preview, write tools, Plan + Goal, diffs + rewind, first-run key wizard, MCP, image/vision, real PTY, guarded GitHub push/PR, Council mode. |
| **v1 Exclusions** | Voice input, HIVE account, hive-cloud login, cloud entitlements. |

---

## 3. UI Information Architecture (Matching Reference Mockup)

```
┌─────────────────────────────────────────────────────────────┐
│  ⬡ HIVE     [ Chat ] [ Codex ]     deepseek / model ▾    ⚙  │
├──────────┬──────────────────────────────────────────────────┤
│          │                                                  │
│  nav     │   active surface (Chat or Codex)                 │
│          │                                                  │
└──────────┴──────────────────────────────────────────────────┘
```

### 3.1 Chat Surface
- **Left Sidebar**:
  - `+ New chat` (with `Ctrl N` shortcut)
  - `🔍 Search chats` input
  - Grouped history: `Today`, `Yesterday`, `Projects` (pinned workspaces with folder path)
  - Profile badge: `H` violet avatar with green online status dot, `Local Mode`, `No account`
- **Main Chat Area**:
  - Chat title header
  - Transcript: Right-aligned user bubbles with timestamp (`10:31 AM`) and user avatar `U`; Left-aligned assistant cards with violet hexagon icon, rich markdown, and copyable syntax-highlighted code blocks.
  - Floating Composer: `Message HIVE...`, attachment actions (paperclip, image, terminal), model picker, violet send button.
  - Footer disclaimer: `🔒 Local mode • All data stays on your device`.

### 3.2 Codex Surface
- **Left Column**: Workspace File Tree
  - Root directory header with workspace path (`hive-desktop C:\Dev\hive-desktop`)
  - Interactive tree (`src`, `main`, `renderer`, `App.tsx`, etc.)
  - Bottom `Sessions` list
- **Middle Column**: Agent Execution & Transcript
  - Session title header (`COD-2026-08-17 Implement file preview`)
  - Mode Switcher tabs: `[ ☿ Agent ]` `[ Plan ]` `[ Goal ]` `[ Council ]`
  - Step & Tool execution cards: `Scanned project files`, `[ Edit file ] App.tsx +42 -8`, `Running terminal command...` with log container and completion check.
  - Composer with `Ask HIVE...`, mode dropdown (`Auto ▾` / `Ask ▾` / `YOLO ▾`), model picker, send button.
  - Status bar: `Auto ▾` | `✓ Checkpoint saved` | `Ln 42, Col 1` | `TypeScript` | `Prettier`
- **Right Column**: File Preview / Diff / Git Panel
  - Tabbed File Preview with line numbers, file metadata (`TypeScript React`, `Size 382 B`, `Modified 2 minutes ago`).
  - Diff Inspector with unified diffs and `Discard` / `Accept` actions.
  - Git Controls box: `Branch: main`, `Commit...`, `Push`, `Create PR`.

---

## 4. Delivery Waves

1. **Wave 1 — Talk**: Kernel contracts, DeepSeek + OpenAI-compatible provider, vault, first-run wizard, Chat surface (stream, sessions, model picker, markdown, receipts).
2. **Wave 2 — Work**: Codex surface shell, file tree + preview, agent write tools, Ask/Auto/YOLO, diffs, checkpoints + rewind, live edits.
3. **Wave 3 — Power**: Plan + Goal, MCP, ConPTY + xterm, image attach on Codex turns.
4. **Wave 4 — Swarm and Ship**: Council mode, guarded GitHub push/PR, packaging (portable + setup), golden-path e2e.
