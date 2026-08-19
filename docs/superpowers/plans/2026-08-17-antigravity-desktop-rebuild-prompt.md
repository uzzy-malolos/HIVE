# Antigravity prompt — HIVE Desktop Kernel rebuild

Copy everything below the line into Antigravity.

---

You are implementing the HIVE Desktop Kernel rebuild in `C:\HIVE`. You are a senior TypeScript/Electron engineer. You ship working software, not skins.

A previous agent already failed this job. They added ChatGPT-looking chrome with **hardcoded fake chats**, a **fake Codex file tree** (`src/renderer/App.tsx` that is not this repo), fake diffs, a fake `pnpm install` log, and a “Checkpoint saved” badge with **no checkpoint code**. `CodexSurface` was never mounted. `App.tsx` still renders the old `Workbench` when Codex is selected. There is **no** `src/kernel/`. The packaged `HIVE-0.6.0-*.exe` files in `dist-binaries/` and `release/` are from **15:34 on 2026-08-17** and do **not** contain this work. Renderer Vitest is 96/96 green because the tests lock the mock. Green tests are not success.

Your job is to replace that failure with the real product.

## Product (locked — do not reopen)

HIVE is a **local-first Windows desktop app**. No HIVE account. No hive-cloud login. No Upgrade/Free chrome. No ChatGPT wordmark. Feels like **ChatGPT Desktop that has Codex in it**, implemented like **Reasonix** (BYOK, one kernel, config-driven providers, tool loop, BM25 memory). Stay on **TypeScript + Electron 43 + React 18 + Vite**. Do **not** rewrite in Go/Wails.

**Two surfaces, one window, one kernel, one key vault:**

1. **Chat** — general conversation. May read a grounded folder and read-only MCP. May attach images if the model supports vision. **Never writes the repo. No PTY. No Council.**
2. **Codex** — coding agent. Requires an open workspace. Live file edits + rewind. Modes: Agent (default), Plan, Goal, Council. Approvals: Ask / Auto / YOLO. Real file tree, preview, diffs, ConPTY, guarded git commit/push/PR.

Shared: providers, encrypted keys, model picker (`provider / model`), `AGENTS.md`/`HIVE.md` instructions, markdown memory facts + BM25, MCP list, theme, honest token/cost receipts.

**Default Codex loop is a single streaming tool-calling agent.** Council is an explicit Codex mode (Queen → Scout → Architect → Forger → Sentinel → Scribe), not the default, not a second product.

**Writes:** live workspace + shadow checkpoints before mutations + Rewind. Isolated worktrees are **not** the default. No auto-push. No force-push. Push/PR always preview → confirm → HEAD recheck.

**RAG:** Reasonix-style. Instructions ≠ memory. BM25 recall of markdown facts + history tool + scout/grep/read as tools. **No vector DB, no embeddings in v1.**

**Providers:** DeepSeek-first (`deepseek-v4-flash` default) + any OpenAI-compatible endpoint as **config**, not a new adapter. Native **streaming + tool calling + usage**. Prompt-complete-only is not Codex. DeepSeek `reasoning_content` stays private (collapsed Thinking chip only). Keys only in Electron `safeStorage` / named env. Never in repo JSON, IPC events, logs, or renderer storage.

**v1 out:** voice, accounts, billing, entitlements, cloning Reasonix/ZCode/Antigravity chrome, restyling `Workbench.tsx` as the architecture.

Read first:

- `docs/superpowers/specs/2026-08-17-hive-desktop-kernel.md`
- `docs/superpowers/plans/2026-08-17-antigravity-desktop-rebuild-prompt.md` (this file)
- `desktop/renderer/src/App.tsx` (still mounts `Workbench` for Codex)
- `desktop/renderer/src/components/chat/ChatSurface.tsx` (fake `demoConversations`)
- `desktop/renderer/src/components/codex/CodexSurface.tsx` (static mock, unused)
- Existing vault: `src/desktop/credential-vault.ts`, `src/desktop/electron/safe-storage.ts`
- Existing chat send path: `src/desktop/chat-service.ts`, `src/chat/engine.ts`
- Existing workspace jail: `src/desktop/workspace-tree.ts`
- Existing guarded git: `src/desktop/guarded-git-service.ts`

Treat **repo code as truth**. Second Brain notes that say the rebuild is done are **wrong**.

## Hard rules (fail the task if you break these)

1. **No fake product data.** No hardcoded chats titled “Explain React Server Components”. No fake `C:\Dev\hive-desktop` tree. No fake diffs. No fake “Checkpoint saved”. Empty states when there is no data.
2. **No restyle-only PRs.** Do not paint Workbench to look like Codex. Mount a real `CodexSurface` driven by real workspace listings and real turns.
3. **Do not claim the 0.6.0 exe is the rebuild.** Only package **after** Wave 2 at minimum (Chat streams + Codex can edit a file + rewind). Then run `npm run desktop:dist` and record the new artifact timestamps.
4. **Renderer never sees secrets, never writes files, never builds prompts.** Worker/main owns the loop.
5. **TDD for kernel.** Write failing node:test files first for provider stream/tools/usage, permissions, memory/recall, session persist, checkpoints. Then implement. Do not add a test that asserts mock copy.
6. **Keep Electron trust boundaries:** main / preload / renderer / utility worker. CSP, no nodeIntegration, allowlisted IPC.
7. **Do not delete the CLI/TUI/Queen yet.** New kernel lives in `src/kernel/` (and friends). Old `hive code` / `hive chat` stay until they can wrap the kernel. You may stop importing Workbench from `App.tsx`.
8. **Brand:** HIVE violet / void black from `hive-brand-kit.json` and current tokens. ChatGPT *information architecture*, not ChatGPT branding.
9. **Windows only for this pass.** ConPTY via `node-pty` when you reach Wave 3. Agent `bash` tool ≠ the human PTY.
10. **Do not update Second Brain / Obsidian with aspirational “100% complete” claims.** Record only what tests and a running window prove.

## Target tree (create these; do not stuff this into App.tsx)

```
src/kernel/          controller, session, agent-loop, permissions, compact, checkpoints
src/providers/       keep presets; openai-compatible must stream + tools + usage
src/tools/           read/write/edit/list, grep/glob, bash, git, memory, history, scout
src/context/         instructions walk, memory-store, BM25 recall
src/mcp/             stdio + HTTP → Tool (Wave 3)
src/surfaces/        chat.ts (read policy) + codex.ts (write policy)
desktop/renderer/src/components/chat/ChatSurface.tsx     REAL sessions only
desktop/renderer/src/components/codex/CodexSurface.tsx   REAL tree/preview/diff/transcript
```

IPC shrinks toward: `workspace.open`, `session.list|create|load|archive`, `turn.submit|cancel`, `approval.respond`, `provider.*`, `mcp.*`, `git.preview|confirm`, `checkpoint.rewind`, `terminal.*`, `settings.*`. Events: `session.changed`, `turn.delta`, `tool.started|finished`, `approval.needed`, `checkpoint.created`, `terminal.data`.

You may add commands incrementally. Do not grow the 40-command soup without a Controller.

## Build order (stop after each wave’s exit and prove it)

### Wave 1 — Talk (do this first; do not skip ahead to pretty Codex chrome)

- Kernel contracts + DeepSeek / openai-compatible stream + tools + usage.
- Vault + **first-run wizard**: pick preset → paste key → test → save. No account.
- Chat surface: real `chat.list` / `chat.create` / `chat.load` / `chat.send`. Streaming markdown. Model picker. Receipts (model, tokens, latency; cost if pricing snapshot exists). Image attach only if `visionModels` includes the selected model; otherwise disable and say so.
- Sidebar lists **real** conversations grouped by day. Search filters real titles. Projects = real grounded folders, not fake paths.
- Wire `App.tsx`: `mode === "chat"` → `ChatSurface`. Delete demo arrays.

**Exit:** `npm run typecheck:desktop-renderer` clean. New kernel tests pass. `npm run desktop:dev` (or `build:desktop` + `desktop:start`) → paste a DeepSeek key → send a message → tokens stream. No fake RSC thread.

### Wave 2 — Work

- Mount `CodexSurface` instead of `Workbench` when `mode === "coder"` (or rename mode to `"codex"` and migrate).
- Opening Codex without a folder opens the folder picker.
- Left: **real** `workspace.list` tree (existing jail: deny `.git`, `node_modules`, `.hivemind`, `dist`, `.env*`, no symlink escape).
- Preview: **real** `workspace.read`.
- Agent turn: native tools `read_file`, `write_file`, `edit_file`, `list_dir`, `glob`, `grep`, `bash` under Ask/Auto/YOLO. Default new session = **Ask**.
- Before mutating tools: checkpoint. UI Rewind restores it and marks discarded transcript tail.
- Diffs from actual file changes. Discard/Accept must do real work or be hidden until they do.

**Exit:** Open `C:\HIVE` in Codex → Agent “add a one-line comment to README.md” → file on disk changes → Rewind restores README. Prove with a test that writes a temp dir, not a screenshot claim.

### Wave 3 — Power

- Plan mode: research + plan card → user approve → execute.
- Goal mode: persist objective, continue until done / blocked / user stop.
- MCP in Settings (stdio/HTTP). Chat only `readOnlyHint` tools. Codex gets the rest under the gate.
- ConPTY + xterm.js on Codex. Human shell. Agent does not hijack the PTY in v1.
- Images on Codex turns if the model can see.

### Wave 4 — Swarm and ship

- Council mode on the same transcript (staged cards), live workspace, checkpoint between stages, Sentinel FAIL → bounded repair. Uses session model unless role assignments exist.
- Guarded GitHub push/PR using existing `guarded-git-service` confirm flow.
- `npm run desktop:dist`. New artifacts only. Then `npm run desktop:smoke`. Tell the operator the **new** filenames, sizes, and timestamps. Do not point at the 15:34 0.6.0 files.

## Verification commands

```
npm run typecheck:desktop-renderer
npm run test:desktop-renderer
npm run build:desktop
# kernel/unit tests you add — they must fail first, then pass
npm run desktop:start
# only after Wave 2+ is real:
npm run desktop:dist
npm run desktop:smoke
```

Do not report “ready to test the rebuild exe” unless `desktop:dist` ran **after** Wave 2 and the exe `LastWriteTime` is newer than the source you just wrote.

## UI notes (after behavior works)

Chat: left New chat (`Ctrl+N`), search, history by day, Local Mode / No account footer. Center transcript + floating “Message HIVE…”. Footer: local-only disclaimer.

Codex: 3 columns — tree+sessions | transcript+modes+composer | preview/diff/git. Status bar shows **true** posture and **true** last checkpoint time, or nothing.

Keep existing settings Providers tab (BYOK + custom OpenAI-compatible). First-run can reuse it.

`App.tsx` is already a god object. Do not make it larger. Extract surface routing. Prefer deleting Workbench from the live path over wrapping it.

## Done means

A user who knows ChatGPT Desktop and Reasonix can:

1. Launch with no account
2. Paste a DeepSeek key and get a green test
3. Use Chat (stream, real history, images if model allows)
4. Switch to Codex, open a folder, and have the agent **edit real files**
5. See real diffs, a real PTY (Wave 3+), honest receipts
6. Choose Plan, Goal, or Council (Waves 3–4)
7. Rewind a bad turn; push only after confirm
8. Close and reopen both surfaces

If you cannot do 1–5 without DualCockpit, personas, Workbench, or fake demo threads, you have not finished.

Start at Wave 1. Do not package. Do not write another visual-parity mock. Implement the kernel and wire Chat to live sessions first.
