# HIVE Desktop Visual Direction & Design System Contract

**Document Version:** 1.0.0  
**Target:** HIVE Windows Desktop Renderer  
**Category:** Native Developer Tooling & Agent Harness  
**Design Baseline:** OpenCode Desktop / Cursor / ChatGPT / Claude / HIVE Verified Runtime  

---

## 1. Design Philosophy & Character

HIVE Desktop is a **mature, technical, and deliberate developer workstation**. It is built for verified autonomous software engineering.

- **Quiet & Restrained**: Deep neutral surfaces, precise typography, crisp 1px borders, and shallow elevation.
- **Signal-Driven Violet**: HIVE violet is an intentional signal color (focus, selection, active agent, verified state, identity), never a blanket wash.
- **Harness First, Editor Second**: The primary object of interest is active work (missions, turns, agent execution, diffs, verification gates), with files, terminal, and browser surfaces organized in support of that work.
- **Continuous Panes over Cards**: Structured cards are strictly reserved for discrete payloads (tool executions, Council transcripts, validation gates, plans, error banners). Standard layout is composed of continuous panes with thin separators.

---

## 2. Layout & Shell Dimensions

| Component | Target Dimension | Allowed Range | Behavior |
| :--- | :--- | :--- | :--- |
| **Titlebar / Tool Strip** | `42px` | 40–44px | Fixed top chrome; brand mark + project/repo path + OpenCode session tabs + worker indicator + window controls |
| **Global Left Sidebar** | `252px` | 240–264px | Persistent workspace navigation: Zone A (Actions), Zone B (Surfaces), Zone C (Active Work / Recent Chats), Footer (Usage, Settings) |
| **HiveChat Reading Column** | `760px` | 720–860px | Center reading container with fluid margin |
| **HiveChat Composer** | `820px` | max 880px | Polished bottom container pinned above footer |
| **Hive Code Inspector (Right)** | `380px` | 320–540px | Collapsible/resizable 5-tab inspector (Changes, Files, Terminal, Evidence, Run) |
| **Split Workspace** | `50% / 50%` | 30%–70% adjustable | Side-by-side HiveChat + Hive Code with draggable splitter |

### Responsive Breakpoints
- **≥ 1440px**: Full 3-pane layout (Sidebar + Main Workspace + Code Inspector).
- **1100–1439px**: Persistent Sidebar + Main Workspace; Code Inspector collapsable or overlaid.
- **800–1099px**: Sidebar collapsed to icon rail / drawer; single auxiliary pane.
- **< 800px**: Single-column responsive fallback.

---

## 3. Color System & Ratio

The interface adheres strictly to the **85% / 10% / 5% Color Rule**:

```
┌───────────────────────────────────────────────────────────┬──────────────┬───────┐
│                   85% Neutral Base                        │  10% Violet  │  5%   │
│  Void Black, Charcoal Panes, Subdued Borders, Crisp Text  │  Signal/Flow │ Sem.  │
└───────────────────────────────────────────────────────────┴──────────────┴───────┘
```

### 3.1 Neutral Foundation (85%)
- `--hive-bg-deep`: `#08080B` (Window canvas, outer chrome, titlebar backdrop)
- `--hive-bg-base`: `#0D0D10` (Primary surface background, conversational canvas)
- `--hive-bg-raised`: `#121217` (Sidebar panels, inspector panes, dialog containers)
- `--hive-bg-hover`: `#18181E` (Interactive row hover, button hover)
- `--hive-bg-selected`: `#1D1926` (Subtle dark purple-tinted neutral for active items)
- `--hive-border-subtle`: `rgba(255, 255, 255, 0.055)` (Inner gridlines, list row separators)
- `--hive-border-default`: `rgba(255, 255, 255, 0.085)` (Panel boundaries, input borders)
- `--hive-border-strong`: `rgba(255, 255, 255, 0.130)` (Selected edges, modal perimeters)

### 3.2 HIVE Violet Signal (10%)
- `--hive-violet`: `#7C3AED` (Primary brand accent, active state border, submit buttons)
- `--hive-violet-soft`: `#8B5CF6` (Hovered accents, active tabs, progress bars)
- `--hive-violet-dim`: `rgba(124, 58, 237, 0.16)` (Selection highlights, active pill background)
- `--hive-violet-glow`: `rgba(139, 92, 246, 0.25)` (Restrained focus rings)

### 3.3 Semantic Colors (5%)
- `--hive-success`: `#22C55E` (Verified PASS, ACCEPTED gate, git additions)
- `--hive-warning`: `#F59E0B` (REPAIRABLE status, warnings, staged changes)
- `--hive-error`: `#EF4444` (REJECTED gate, BLOCKED run, git deletions, errors)

---

## 4. Typography

### 4.1 Interface Typography (UI Sans)
```css
font-family: "Segoe UI Variable", "Inter", -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
```
Used for:
- Navigation labels and headers
- General chat messages and prose
- Buttons, inputs, and form controls
- Settings and dashboard analytics
- Menu options and tooltips

### 4.2 Technical Typography (Technical Mono)
```css
font-family: "JetBrains Mono", "Cascadia Code", "SF Mono", Consolas, monospace;
```
Used for:
- Source code and inline `code` blocks
- File paths and workspace directory trees
- Terminal output and PTY streams
- Git commit hashes and diff annotations (`+182 -493`)
- Token telemetry, duration counters, and evidence IDs
- Model IDs (`qwen/qwen3-coder`, `deepseek-v4-flash`)

---

## 5. Geometry & Radii

Restrained desktop-tool geometry:
- `--radius-sm`: `5px` (Buttons, inputs, inline badges, tab chips)
- `--radius-md`: `7px` (Panels, cards, composer containers, flyout menus)
- `--radius-lg`: `10px` (Modals, full dialog frames)

*Prohibited: 14px–24px oversized SaaS pill curves for normal desktop controls.*

---

## 6. Prohibited Visual Anti-Patterns (Slop Defense)

The following patterns are **strictly prohibited**:
1. **Full-surface violet gradients** across application backdrops.
2. **Glassmorphism / heavy backdrop blur** on core toolbars and titlebars.
3. **Pervasive glowing borders / neon outlines** on cards and panels.
4. **Permanent scanlines, starfields, or honeycomb textures** across active workspace surfaces.
5. **Giant cartoon bee or novelty artwork** in productivity screens.
6. **Card-in-card nesting** for basic tool layouts (e.g. wrapping every response in an individual card).
7. **Monospace for everything** (breaks reading rhythm for long-form prose and instructions).
8. **Ambiguous or dead navigation items** (Runs/Usage must be genuine or hidden/prototyped).
9. **Fabricated cost statistics** (never guess spend without authoritative pricing metadata).
10. **The term `YOLO`** (violates HIVE's verified engineering principles; use `Autonomous`/`Guarded`).

---

## 7. Component Specifications

### 7.1 Titlebar & Session Tabs
- Height: `42px`, background: `--hive-bg-deep`.
- Left: Hexagonal HIVE mark (16×16) + crisp "HIVE" wordmark + active workspace folder.
- Center: OpenCode-style session tabs (`WorkspaceTab`) with close button, reorder support, `Ctrl+1..9` / `Ctrl+Tab` shortcuts, and `+` new session button.
- Right: Worker execution pill (`idle` / `running`), model routing pill, settings shortcut, window controls.

### 7.2 Left Sidebar (Global Navigation)
- Width: `252px`, background: `--hive-bg-raised`, 1px right border.
- **Zone A (Actions)**: `+ New task` button + Command palette search button (`Ctrl+K`).
- **Zone B (Surfaces)**: `Chat` (HiveChat), `Code` (Hive Code), `Split` (Side-by-side), `Runs` (Telemetry).
- **Zone C (Contextual Sessions)**:
  - When in Chat: `RECENT CHATS` with title, date, and archive action.
  - When in Code: `ACTIVE WORK` with mission title and live status tag (`RUNNING`, `REVIEW`, `DONE`, `FAILED`).
- **Footer**: `Usage` and `Settings` workspace links.

### 7.3 HiveChat Canvas & Composer
- Clean ChatGPT/Claude reading column (`760px` centered).
- User and Assistant messages rendered directly onto the dark canvas without bounding cards.
- Structured card blocks only for: tool executions, Council transcripts, verdicts, plans, errors.
- Assistant turns with implementation suggestions provide a 1-click `Build in Hive Code →` action.
- Bottom composer:
  - Pill-style compact container with auto-expanding textarea.
  - Controls: `+` Attach, `Auto ▾` Persona picker, `Tools ▾` Agent toggle, `Model ▾` Selector, `↑` Send button.

### 7.4 Hive Code Agent Harness
- **Center Session**:
  - Mission header with active goal, safety posture (`Guarded` / `Standard` / `Autonomous`), and mode (`Agent` / `Plan` / `Build` / `Council`).
  - Stream of turns with compact inline agent activity rows:
    ```
    ● Scout      searched 38 files                  4s
    ● Planner    created implementation plan        8s
    ◉ Builder    editing desktop/renderer/styles   18s
    ○ Validator  waiting
    ○ Reviewer   waiting
    ```
  - Bottom coding composer with prompt input and execution triggers.
- **Right Tabbed Inspector (380px)**:
  - **Changes**: File list with additions/deletions badges (`+182 -493`), file selection, side-by-side / unified diff view, and guarded git commit/push actions.
  - **Files**: Hierarchical repository tree with expand/collapse and file preview.
  - **Terminal**: Embedded PTY stream with copy/clear controls and command history.
  - **Evidence**: Verification status display (`ACCEPTED`, `REPAIRABLE`, `REJECTED`, `BLOCKED`) with test breakdown, linter/typecheck gates, and reviewer findings.
  - **Run**: Execution profile, active agent roles, token usage telemetry, worktree isolation status, and branch metadata.

### 7.5 Workspace Settings (Master-Detail)
- Dedicated workspace surface (not a cramped modal).
- Left navigation: General, Appearance, Providers, Models, Agent Roles, Security, Keyboard, Usage, About.
- Provider / Model master-detail view:
  - Left column: Configured providers with status dots.
  - Right pane: Selected provider details (Base URL, DPAPI Vault API key, default model, model catalog table with token limits and enable toggles).

### 7.6 Truthful Usage Workspace
- Top: Time range filters (`7 days` | `30 days` | `90 days`).
- Primary KPI grid: Total Tokens, Sessions, Messages, Active Days, Current Streak, Favorite Model.
- Secondary grids: Tokens by Model, Tokens by Agent Role, Verification Success Rate.
- Explicit Truthful Cost Disclaimer: "Spend estimation unavailable — requires provider pricing snapshot".

---

## 8. Verification & Gate
All UI implementations must pass the **First-Glance Test** (looks in the league of OpenCode, Cursor, and Zed) and **Slop Defense Checklist** before merge.
