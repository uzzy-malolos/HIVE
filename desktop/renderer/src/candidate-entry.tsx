import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import type { DesktopCommand, DesktopEvent, ThreadRecordV1 } from "../../../src/desktop/types";
import type { HiveDesktopBridge } from "./bridge";

const params = new URLSearchParams(window.location.search);
const scenario = params.get("scenario") || "chat-active";

const now = new Date().toISOString();

const threadActive: ThreadRecordV1 = {
  schemaVersion: 1,
  id: "thread-active-1",
  title: "Implement Session Tabs & Provider Router",
  createdAt: now,
  updatedAt: now,
  archived: false,
  messages: [
    {
      id: "msg-user-1",
      role: "user",
      content: "Implement OpenCode-class session tabs in the desktop titlebar and wire persistent terminal PTYs.",
      createdAt: now,
    },
    {
      id: "msg-asst-1",
      role: "assistant",
      content: "I have analyzed the session requirements and decomposed the task into 3 phases.",
      createdAt: now,
    },
  ],
  runs: [
    {
      userMessageId: "msg-user-1",
      codingSessionId: "session-active-1",
      status: "completed",
      createdAt: now,
      updatedAt: now,
    },
  ],
};

const providersList = [
  { id: "openrouter", name: "OpenRouter", kind: "openai-compatible" as const, authType: "api-key" as const, baseUrl: "https://openrouter.ai/api/v1", defaultModel: "qwen/qwen-2.5-coder-32b-instruct", approved: true, configured: true },
  { id: "anthropic", name: "Anthropic", kind: "anthropic" as const, authType: "api-key" as const, defaultModel: "claude-3-7-sonnet-20250219", approved: true, configured: true },
  { id: "openai", name: "OpenAI", kind: "openai" as const, authType: "api-key" as const, defaultModel: "gpt-4o", approved: true, configured: false },
  { id: "ollama", name: "Ollama (Local)", kind: "ollama" as const, authType: "none" as const, baseUrl: "http://localhost:11434", defaultModel: "qwen2.5-coder:32b", approved: true, configured: true },
];

const openRouterModels = [
  { id: "qwen/qwen-2.5-coder-32b-instruct", name: "Qwen 2.5 Coder 32B Instruct", contextWindow: 32768 },
  { id: "deepseek/deepseek-coder", name: "DeepSeek Coder V2.5", contextWindow: 65536 },
  { id: "anthropic/claude-3.7-sonnet", name: "Claude 3.7 Sonnet", contextWindow: 200000 },
  { id: "openai/gpt-4o", name: "GPT-4o", contextWindow: 128000 },
];

interface ExtendedBridge extends HiveDesktopBridge {
  emit: (event: DesktopEvent) => void;
}

function createMockBridge(targetScenario: string): ExtendedBridge {
  const listeners = new Set<(event: DesktopEvent) => void>();

  const isChatEmpty = targetScenario === "chat-empty";

  const activeChat = isChatEmpty ? null : {
    id: "conv-1",
    cwd: "C:\\HIVE",
    role: "planning",
    ground: false,
    createdAt: now,
    updatedAt: now,
    messages: [
      {
        id: "m-1",
        role: "user" as const,
        content: "How should we implement the new session-oriented desktop tabs and provider router for HIVE?",
        at: now,
      },
      {
        id: "m-2",
        role: "assistant" as const,
        content: "To support OpenCode-class session management without destroying terminal PTYs or active prompt state, we should maintain persistent session descriptors in a top-level tab strip and route workspace surfaces dynamically.\n\n```typescript\n// 1. Session descriptor\ninterface WorkspaceTab {\n  id: string;\n  kind: \"chat\" | \"run\" | \"file\" | \"diff\";\n  title: string;\n  active: boolean;\n}\n```\n\nI have outlined the complete file diff and verified it against HIVE's IPC safety invariants.",
        at: now,
        receipt: {
          role: "planning",
          providerId: "openrouter",
          model: "qwen-2.5-coder",
          source: "role-assignment",
          degraded: false,
          totalTokens: 1420,
          latencyMs: 820,
        },
      },
    ],
  };

  const bridge: ExtendedBridge = {
    async request(command: DesktopCommand): Promise<DesktopEvent> {
      switch (command.type) {
        case "repository.list":
          return { type: "repository.listed", timestamp: now, repositories: [{ path: "C:\\HIVE", lastOpenedAt: now }] };
        case "chat.list":
          return {
            type: "chat.listed",
            timestamp: now,
            conversations: isChatEmpty ? [] : [
              { id: "conv-1", title: "Session Tabs & Provider Router", updatedAt: now, role: "planning", messageCount: 2 },
              { id: "conv-2", title: "Desktop Theme Tokens", updatedAt: now, role: "coding", messageCount: 4 },
            ],
          };
        case "chat.load":
          return activeChat ? { type: "chat.changed", timestamp: now, conversation: activeChat } : { type: "chat.listed", timestamp: now, conversations: [] };
        case "provider.list":
          return { type: "provider.listed", timestamp: now, providers: providersList };
        case "models.list":
          return { type: "models.listed", timestamp: now, providerId: command.providerId, models: openRouterModels };
        case "thread.list":
          return { type: "thread.listed", timestamp: now, threads: [threadActive] };
        case "thread.load":
          return { type: "thread.changed", timestamp: now, thread: threadActive };
        case "git.inspect":
          return {
            type: "git.changed",
            timestamp: now,
            status: {
              repositoryRoot: "C:\\HIVE",
              branch: "feat/session-tabs-harness",
              head: "a1b2c3d",
              dirty: true,
              changedFiles: [
                "desktop/renderer/src/shell/WorkspaceTabs.tsx",
                "desktop/renderer/src/shell/Sidebar.tsx",
                "desktop/renderer/src/styles/tokens.css",
              ],
              ahead: 0,
              behind: 0,
            },
          };
        case "changes.diff":
          return {
            type: "changes.diffed",
            timestamp: now,
            diff: {
              repositoryRoot: "C:\\HIVE",
              codingSessionId: "session-active-1",
              patch: `diff --git a/desktop/renderer/src/shell/WorkspaceTabs.tsx b/desktop/renderer/src/shell/WorkspaceTabs.tsx
--- a/desktop/renderer/src/shell/WorkspaceTabs.tsx
+++ b/desktop/renderer/src/shell/WorkspaceTabs.tsx
@@ -10,6 +10,12 @@
+export interface WorkspaceTab {
+  id: string;
+  title: string;
+  kind: "chat" | "coder";
+  active: boolean;
+}
diff --git a/desktop/renderer/src/shell/Sidebar.tsx b/desktop/renderer/src/shell/Sidebar.tsx
--- a/desktop/renderer/src/shell/Sidebar.tsx
+++ b/desktop/renderer/src/shell/Sidebar.tsx
@@ -24,8 +24,14 @@
-  const [activeNav, setActiveNav] = useState("chat");
+  const [activeNav, setActiveNav] = useState<NavSection>("chat");
+  const handleSelect = (section: NavSection) => {
+    setActiveNav(section);
+    onNavigate?.(section);
+  };
diff --git a/desktop/renderer/src/styles/tokens.css b/desktop/renderer/src/styles/tokens.css
--- a/desktop/renderer/src/styles/tokens.css
+++ b/desktop/renderer/src/styles/tokens.css
@@ -40,7 +40,22 @@
-  --hive-sidebar-width: 252px;
+  --hive-sidebar-width: 256px;
+  --hive-inspector-width: 390px;`,
              truncated: false,
              recordedFiles: [
                "desktop/renderer/src/shell/WorkspaceTabs.tsx",
                "desktop/renderer/src/shell/Sidebar.tsx",
                "desktop/renderer/src/styles/tokens.css",
              ],
              reviewedFiles: ["desktop/renderer/src/shell/WorkspaceTabs.tsx"],
              commitEligibility: "eligible",
            },
          };
        case "run.report":
          return {
            type: "run.reported",
            timestamp: now,
            codingSessionId: "session-active-1",
            report: {
              result: "Session tabs successfully wired into titlebar and persistent shell.",
              verdict: "ACCEPTED",
              verdictReasons: ["All 102 renderer tests pass", "0 TypeScript typecheck errors", "Zero state regression on tab cycle"],
              subagents: { total: 4, active: 0, working: 0, waiting: 0, blocked: 0, done: 4, completed: 4, failed: 0, cancelled: 0, skipped: 0 },
              filesChanged: [
                "desktop/renderer/src/shell/WorkspaceTabs.tsx",
                "desktop/renderer/src/shell/Sidebar.tsx",
                "desktop/renderer/src/styles/tokens.css",
              ],
              validation: [
                { label: "Unit tests", status: "passed" },
                { label: "Typecheck", status: "passed" },
                { label: "IPC contract validation", status: "passed" },
              ],
              review: ["Clean architecture", "No leak of secrets", "Zero unhandled exceptions"],
              outstanding: [],
              completedAt: now,
            },
          };
        default:
          return { type: "request.completed", timestamp: now, requestId: command.requestId };
      }
    },
    subscribe(listener: (event: DesktopEvent) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit(event: DesktopEvent) {
      for (const listener of listeners) {
        listener(event);
      }
    },
  };

  return bridge;
}

const mockBridge = createMockBridge(scenario);

// Seed initial preferences based on scenario
const initialMode =
  scenario.startsWith("chat") ? "chat" :
  scenario.startsWith("code") ? "coder" :
  scenario === "split" ? "split" :
  scenario === "settings" ? "settings" :
  scenario === "usage" ? "usage" : "chat";

localStorage.setItem("hive.desktop.ui.v1", JSON.stringify({
  v: 1,
  mode: initialMode,
  density: "comfortable",
  accent: "vivid",
  composerSendWithEnter: true,
}));

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(<App api={mockBridge} />);

  setTimeout(() => {
    mockBridge.emit({ type: "desktop.ready", timestamp: now, repositoryRoot: "C:\\HIVE" });
    if (scenario === "chat-active") {
      mockBridge.emit({
        type: "chat.changed",
        timestamp: now,
        conversation: {
          id: "conv-1",
          cwd: "C:\\HIVE",
          role: "planning",
          ground: false,
          createdAt: now,
          updatedAt: now,
          messages: [
            {
              id: "m-1",
              role: "user",
              content: "How should we implement the new session-oriented desktop tabs and provider router for HIVE?",
              at: now,
            },
            {
              id: "m-2",
              role: "assistant",
              content: "To support OpenCode-class session management without destroying terminal PTYs or active prompt state, we should maintain persistent session descriptors in a top-level tab strip and route workspace surfaces dynamically.\n\n```typescript\n// 1. Session descriptor\ninterface WorkspaceTab {\n  id: string;\n  kind: \"chat\" | \"coder\";\n  title: string;\n  active: boolean;\n}\n```\n\nI have verified this against HIVE's IPC safety invariants.",
              at: now,
              receipt: {
                role: "planning",
                providerId: "openrouter",
                model: "qwen-2.5-coder",
                source: "role-assignment",
                degraded: false,
                totalTokens: 1420,
                latencyMs: 820,
              },
            },
          ],
        },
      });
    }

    const isCoderMode =
      scenario.startsWith("code") ||
      scenario === "split";

    if (isCoderMode) {
      mockBridge.emit({ type: "thread.changed", timestamp: now, thread: threadActive });
      mockBridge.emit({
        type: "git.changed",
        timestamp: now,
        status: {
          repositoryRoot: "C:\\HIVE",
          branch: "feat/session-tabs-harness",
          head: "a1b2c3d",
          dirty: true,
          changedFiles: [
            "desktop/renderer/src/shell/WorkspaceTabs.tsx",
            "desktop/renderer/src/shell/Sidebar.tsx",
            "desktop/renderer/src/styles/tokens.css",
          ],
          ahead: 0,
          behind: 0,
        },
      });

      mockBridge.emit({
        type: "changes.diffed",
        timestamp: now,
        diff: {
          repositoryRoot: "C:\\HIVE",
          codingSessionId: "session-active-1",
          patch: `diff --git a/desktop/renderer/src/shell/WorkspaceTabs.tsx b/desktop/renderer/src/shell/WorkspaceTabs.tsx
--- a/desktop/renderer/src/shell/WorkspaceTabs.tsx
+++ b/desktop/renderer/src/shell/WorkspaceTabs.tsx
@@ -10,6 +10,12 @@
+export interface WorkspaceTab {
+  id: string;
+  title: string;
+  kind: "chat" | "coder";
+  active: boolean;
+}
diff --git a/desktop/renderer/src/shell/Sidebar.tsx b/desktop/renderer/src/shell/Sidebar.tsx
--- a/desktop/renderer/src/shell/Sidebar.tsx
+++ b/desktop/renderer/src/shell/Sidebar.tsx
@@ -24,8 +24,14 @@
-  const [activeNav, setActiveNav] = useState("chat");
+  const [activeNav, setActiveNav] = useState<NavSection>("chat");
+  const handleSelect = (section: NavSection) => {
+    setActiveNav(section);
+    onNavigate?.(section);
+  };
diff --git a/desktop/renderer/src/styles/tokens.css b/desktop/renderer/src/styles/tokens.css
--- a/desktop/renderer/src/styles/tokens.css
+++ b/desktop/renderer/src/styles/tokens.css
@@ -40,7 +40,22 @@
-  --hive-sidebar-width: 252px;
+  --hive-sidebar-width: 256px;
+  --hive-inspector-width: 390px;`,
          truncated: false,
          recordedFiles: [
            "desktop/renderer/src/shell/WorkspaceTabs.tsx",
            "desktop/renderer/src/shell/Sidebar.tsx",
            "desktop/renderer/src/styles/tokens.css",
          ],
          reviewedFiles: ["desktop/renderer/src/shell/WorkspaceTabs.tsx"],
          commitEligibility: "eligible",
        },
      });

      mockBridge.emit({
        type: "run.reported",
        timestamp: now,
        codingSessionId: "session-active-1",
        report: {
          result: "Session tabs successfully wired into titlebar and persistent shell.",
          verdict: "ACCEPTED",
          verdictReasons: ["All 102 renderer tests pass", "0 TypeScript typecheck errors", "Zero state regression on tab cycle"],
          subagents: { total: 4, active: 0, working: 0, waiting: 0, blocked: 0, done: 4, completed: 4, failed: 0, cancelled: 0, skipped: 0 },
          filesChanged: [
            "desktop/renderer/src/shell/WorkspaceTabs.tsx",
            "desktop/renderer/src/shell/Sidebar.tsx",
            "desktop/renderer/src/styles/tokens.css",
          ],
          validation: [
            { label: "Unit tests", status: "passed" },
            { label: "Typecheck", status: "passed" },
            { label: "IPC contract validation", status: "passed" },
          ],
          review: ["Clean architecture", "No leak of secrets", "Zero unhandled exceptions"],
          outstanding: [],
          completedAt: now,
        },
      });

      if (scenario === "code-evidence") {
        setTimeout(() => {
          const allTabs = Array.from(document.querySelectorAll<HTMLButtonElement>(".hive-inspector-tab"));
          const evTab = allTabs.find((t) => t.textContent?.includes("Evidence"));
          evTab?.click();
        }, 200);
      } else if (scenario === "code-run") {
        setTimeout(() => {
          const allTabs = Array.from(document.querySelectorAll<HTMLButtonElement>(".hive-inspector-tab"));
          const rTab = allTabs.find((t) => t.textContent?.includes("Run"));
          rTab?.click();
        }, 200);
      } else if (scenario === "code-changes") {
        setTimeout(() => {
          const allTabs = Array.from(document.querySelectorAll<HTMLButtonElement>(".hive-inspector-tab"));
          const chTab = allTabs.find((t) => t.textContent?.includes("Changes"));
          chTab?.click();
        }, 200);
      } else if (scenario === "code-diff-expanded") {
        setTimeout(() => {
          const allTabs = Array.from(document.querySelectorAll<HTMLButtonElement>(".hive-inspector-tab"));
          const chTab = allTabs.find((t) => t.textContent?.includes("Changes"));
          chTab?.click();
          setTimeout(() => {
            const expandBtn = document.querySelector<HTMLButtonElement>(".hive-inspector-expand-btn");
            expandBtn?.click();
          }, 150);
        }, 200);
      }
    }
  }, 100);
}
