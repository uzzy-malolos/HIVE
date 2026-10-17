import { FormEvent, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { DesktopCommand, DesktopCredentialKind, DesktopEvent, DesktopProviderConfigurationInput, DesktopProviderMetadata, GuardedGitActionPreview, ThreadMessage, ThreadRecordV1 } from "../../../src/desktop/types";
import type { HiveDesktopBridge } from "./bridge";
import { installedBridge, type DesktopCommandInput } from "./bridge";
import { CommandPalette, PaletteCommand } from "./components/CommandPalette";
import { ConfirmationDialog } from "./components/ConfirmationDialog";
import { Dialog } from "./Dialog";
import { ProviderDialog } from "./components/ProviderDialog";
import { SettingsDialog } from "./components/SettingsDialog";
import { SettingsSurface } from "./components/settings/SettingsSurface";
import { UsageSurface } from "./components/usage/UsageSurface";
import { SplitWorkspace } from "./components/SplitWorkspace";
import { CodexSurface } from "./components/codex/CodexSurface";
import type { InspectorTab } from "./components/inspector/InspectorTabs";
import { ShortcutHelp } from "./components/ShortcutHelp";
import { Toast, ToastItem } from "./components/Toast";
import { ChatSurface } from "./components/chat/ChatSurface";
import { Shell } from "./shell/Shell";
import type { SidebarSession } from "./shell/Sidebar";
import type { WorkspaceTab } from "./shell/WorkspaceTabs";
import { notifyRunCompleted } from "./notifications";
import { loadPrefs, usePrefs } from "./prefs";
import { initialDesktopState, latestRun, reduceDesktopEvent, type CenterTab, type DesktopMode } from "./state";
import { identifier, projectName, terminalStatuses } from "./utils";
import "./styles.css";
import "./styles/motion.css";

export function App({ api: suppliedApi }: { api?: HiveDesktopBridge }) {
  const api = suppliedApi ?? installedBridge();
  const [state, dispatch] = useReducer(reduceDesktopEvent, undefined, initialDesktopState);
  const { prefs, updatePrefs } = usePrefs();

  const [composer, setComposer] = useState("");
  const [saving, setSaving] = useState(false);
  const [retryMessageId, setRetryMessageId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newThreadTitle, setNewThreadTitle] = useState("New HIVE task");
  const [modelChoice, setModelChoice] = useState<{ providerId: string; model: string } | null>(null);

  const [providerDialog, setProviderDialog] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<"general" | "models" | "catalog">("general");
  const [modelsLoading, setModelsLoading] = useState<Record<string, boolean>>({});
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string } | null>(null);
  const [archivedOpen, setArchivedOpen] = useState(false);
  // Chats deleted but still inside their undo window; hidden now, removed when the timer fires.
  const [pendingDeletes, setPendingDeletes] = useState<string[]>([]);
  const deleteTimers = useRef(new Map<string, { timer: ReturnType<typeof setTimeout>; run: () => Promise<void> }>());
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const dismissToast = (id: string): void => setToasts((prev) => prev.filter((t) => t.id !== id));
  const showToast = (toast: Omit<ToastItem, "id">, durationMs = 6000): string => {
    const id = identifier("toast");
    setToasts((prev) => [...prev, { ...toast, id }]);
    setTimeout(() => dismissToast(id), durationMs);
    return id;
  };
  const [stickyError, setStickyError] = useState<string | null>(null);

  async function fetchModels(providerId: string): Promise<void> {
    setModelsLoading((prev) => ({ ...prev, [providerId]: true }));
    try {
      await send({ type: "models.list", providerId });
    } catch {
      // send() already surfaces request.failed when the bridge returns a typed failure
    } finally {
      setModelsLoading((prev) => ({ ...prev, [providerId]: false }));
    }
  }

  const [credential, setCredential] = useState("");
  const credentialRef = useRef("");
  const mainRef = useRef<HTMLElement>(null);
  const tabRefs = useRef<Record<CenterTab, HTMLButtonElement | null>>({ conversation: null, changes: null, report: null });
  const repositoryRef = useRef<string | null>(null);
  const openEpochRef = useRef(0);
  const chatRequestIds = useRef(new Set<string>());
  const modelsRequested = useRef(new Set<string>());
  const startNewChatRef = useRef<() => void>(() => {});

  const splitRatio = prefs.splitRatio ?? 0.4;

  // Sync density and accent attributes to root HTML element
  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.dataset.density = prefs.density ?? "comfortable";
      document.documentElement.dataset.accent = prefs.accent ?? "vivid";
    }
  }, [prefs.density, prefs.accent]);

  useEffect(() => {
    if (prefs.rails) {
      dispatch({ type: "ui.rails.set", rails: prefs.rails });
    }
    if (prefs.mode) {
      dispatch({ type: "ui.mode", mode: prefs.mode });
    }
  }, []);

  const send = async (command: DesktopCommandInput, scope?: { epoch?: number; repositoryRoot?: string }): Promise<DesktopEvent> => {
    const requestId = command.requestId ?? identifier("request");
    if (command.type === "chat.send" || command.type === "chat.create" || command.type === "chat.cancel" || command.type === "chat.list") {
      chatRequestIds.current.add(requestId);
    }
    const expectedEpoch = scope?.epoch ?? openEpochRef.current;
    const event = await api.request({ ...command, requestId } as DesktopCommand);
    if (expectedEpoch !== openEpochRef.current) return { type: "request.failed", timestamp: new Date().toISOString(), requestId, message: "Request superseded by a repository switch.", recoverable: true };
    if (scope?.repositoryRoot && event.repositoryRoot && event.repositoryRoot.toLowerCase() !== scope.repositoryRoot.toLowerCase()) return event;
    if (!scope?.epoch && event.repositoryRoot && (!repositoryRef.current || event.repositoryRoot.toLowerCase() !== repositoryRef.current.toLowerCase())) return event;
    dispatch(event);
    // Chat commands report their own failures; chat.list fails harmlessly until a project is open.
    if (event.type === "request.failed" && command.type !== "chat.send" && command.type !== "chat.create" && command.type !== "chat.list") {
      setStickyError(event.message);
    } else if (event.type === "worker.failed") {
      setStickyError(event.message);
    } else if (event.type === "desktop.ready" || event.type === "chat.started" || event.type === "chat.completed") {
      setStickyError(null);
    }
    return event;
  };

  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    const unsubscribe = api.subscribe((event) => {
      if (event.type === "desktop.ready" && !repositoryRef.current) {
        repositoryRef.current = event.repositoryRoot ?? null;
        dispatch(event);
        return;
      }
      if (event.repositoryRoot && (!repositoryRef.current || event.repositoryRoot.toLowerCase() !== repositoryRef.current.toLowerCase())) return;
      dispatch(event);
      if (event.type === "request.failed") {
        if (event.requestId && chatRequestIds.current.has(event.requestId)) {
          chatRequestIds.current.delete(event.requestId);
        } else {
          setStickyError(event.message);
        }
      } else if (event.type === "worker.failed") {
        setStickyError(event.message);
      } else if (event.type === "chat.started" || event.type === "chat.completed") {
        setStickyError(null);
      }

      // Presence & Toast on run completion
      if (event.type === "run.changed" && terminalStatuses.has(event.run.status)) {
        const ownerThread = stateRef.current.threads.find((t) => t.runs.some((r) => r.codingSessionId === event.run.codingSessionId));
        const threadTitle = ownerThread?.title ?? "HIVE Run";
        const tone = event.run.status === "completed" ? "success" : "error";
        const toastId = identifier("toast");
        const messageText = `Run ${event.run.status}: ${threadTitle}`;

        setToasts((prev) => [...prev, { id: toastId, tone, text: messageText }]);
        notifyRunCompleted("HIVE Cockpit", { threadTitle, status: event.run.status });

        setTimeout(() => {
          setToasts((prev) => prev.filter((t) => t.id !== toastId));
        }, 6000);
      }
    });
    void send({ type: "repository.list" });
    void send({ type: "chat.list" });
    void send({ type: "provider.list" });
    return unsubscribe;
  }, [api]);

  function clearCredential(): void { credentialRef.current = ""; setCredential(""); }
  function closeProviderDialog(): void { clearCredential(); setProviderDialog(false); }

  const activeThread = state.threads.find((thread) => thread.id === state.activeThreadId);
  const currentRun = state.run ?? latestRun(activeThread);
  const activeRun = currentRun && !terminalStatuses.has(currentRun.status) ? currentRun : null;
  const repositoryActiveRun = state.threads.flatMap((thread) => thread.runs).find((run) => !terminalStatuses.has(run.status)) ?? null;
  const sessionId = currentRun?.codingSessionId;
  const report = sessionId ? state.reports[sessionId] : null;
  const modalOpen = Boolean(state.preview || providerDialog || settingsOpen || paletteOpen || searchOpen || shortcutHelpOpen || deleteTarget || archivedOpen);

  // --- Shell-derived navigation/tabs -------------------------------------------------
  const openSettingsModels = () => { setSettingsTab("models"); setSettingsOpen(true); };

  const modelOptions = useMemo(() => {
    const options: { providerId: string; providerName: string; model: string }[] = [];
    for (const provider of state.providers) {
      if (!provider.configured) continue;
      const listed = state.modelsByProvider[provider.id] ?? [];
      if (listed.length > 0) {
        for (const model of listed) options.push({ providerId: provider.id, providerName: provider.name, model: model.id });
      } else if (provider.defaultModel) {
        options.push({ providerId: provider.id, providerName: provider.name, model: provider.defaultModel });
      }
    }
    return options;
  }, [state.providers, state.modelsByProvider]);

  const activeModelName = modelChoice
    ? `${state.providers.find((provider) => provider.id === modelChoice.providerId)?.name ?? modelChoice.providerId} / ${modelChoice.model}`
    : "No model";

  useEffect(() => {
    for (const provider of state.providers) {
      if (!provider.configured || modelsRequested.current.has(provider.id)) continue;
      modelsRequested.current.add(provider.id);
      void fetchModels(provider.id);
    }
  }, [state.providers]);

  useEffect(() => {
    setModelChoice((current) => {
      if (current && modelOptions.some((option) => option.providerId === current.providerId && option.model === current.model)) return current;
      const first = modelOptions[0];
      return first ? { providerId: first.providerId, model: first.model } : null;
    });
  }, [modelOptions]);

  const recentSessions: SidebarSession[] = useMemo(() => {
    if (state.mode === "coder") {
      return state.threads
        .filter((thread) => !thread.archived)
        .slice()
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .map((thread) => {
          const live = [...thread.runs].reverse().find((run) => !terminalStatuses.has(run.status));
          return {
            id: `thread-${thread.id}`,
            title: thread.title,
            kind: "coder" as const,
            active: thread.id === state.activeThreadId,
            updatedAt: thread.updatedAt,
            busy: Boolean(live),
            ...(live ? { status: live.status } : {}),
          };
        });
    }
    return state.chat.conversations
      .filter((conversation) => !conversation.archived && !pendingDeletes.includes(`chat-${conversation.id}`))
      .slice()
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((conversation) => ({
        id: `chat-${conversation.id}`,
        title: conversation.title || "New chat",
        kind: "chat" as const,
        active: conversation.id === state.chat.activeId,
        updatedAt: conversation.updatedAt,
        busy: Boolean(state.chat.streaming[conversation.id]),
      }));
  }, [state.mode, state.chat.conversations, state.chat.activeId, state.chat.streaming, state.threads, state.activeThreadId, pendingDeletes]);

  const sessionTabs: WorkspaceTab[] = recentSessions.slice(0, 4).map((s) => ({ id: s.id, label: s.title, kind: s.kind }));
  const activeTabId = state.mode === "chat"
    ? (state.chat.activeId ? `chat-${state.chat.activeId}` : null)
    : (state.activeThreadId ? `thread-${state.activeThreadId}` : null);

  const handleSelectSession = (id: string): void => {
    if (id.startsWith("chat-")) {
      const conversationId = id.slice("chat-".length);
      void send({ type: "chat.load", conversationId });
      dispatch({ type: "ui.mode", mode: "chat" });
    } else if (id.startsWith("thread-")) {
      const thread = state.threads.find((entry) => entry.id === id.slice("thread-".length));
      if (thread) void loadThread(thread);
      dispatch({ type: "ui.mode", mode: "coder" });
    }
  };

  const starredIds = prefs.starred ?? [];
  const toggleStar = (id: string): void => {
    const current = prefs.starred ?? [];
    updatePrefs({ starred: current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id] });
  };

  const archiveSession = async (id: string): Promise<void> => {
    if (prefs.starred?.includes(id)) updatePrefs({ starred: prefs.starred.filter((entry) => entry !== id) });
    if (id.startsWith("chat-")) {
      const conversationId = id.slice("chat-".length);
      const archived = await send({ type: "chat.archive", conversationId });
      // Archiving the open chat lands on a fresh one, as ChatGPT and Claude do.
      if (archived.type === "chat.listed" && state.chat.activeId === conversationId) await handleNewTask();
    } else if (id.startsWith("thread-")) {
      await send({ type: "thread.archive", threadId: id.slice("thread-".length) });
    }
  };

  const renameChat = async (id: string, title: string): Promise<void> => {
    if (!id.startsWith("chat-")) return;
    await send({ type: "chat.rename", input: { conversationId: id.slice("chat-".length), title } });
  };

  const DELETE_UNDO_MS = 6000;
  const settlePendingDelete = (id: string): void => {
    const pending = deleteTimers.current.get(id);
    if (pending) clearTimeout(pending.timer);
    deleteTimers.current.delete(id);
    setPendingDeletes((prev) => prev.filter((entry) => entry !== id));
  };

  // The chat disappears at once but is only removed after the undo window; closing the app inside it keeps the chat.
  const confirmDeleteChat = async (): Promise<void> => {
    if (!deleteTarget) return;
    const { id, title } = deleteTarget;
    setDeleteTarget(null);
    const conversationId = id.slice("chat-".length);
    setPendingDeletes((prev) => [...prev, id]);
    let toastId = "";
    const run = async (): Promise<void> => {
      settlePendingDelete(id);
      dismissToast(toastId);
      const deleted = await send({ type: "chat.delete", conversationId });
      if (deleted.type !== "chat.listed") return;
      const starred = loadPrefs().starred;
      if (starred?.includes(id)) updatePrefs({ starred: starred.filter((entry) => entry !== id) });
    };
    deleteTimers.current.set(id, { timer: setTimeout(() => void run(), DELETE_UNDO_MS), run });
    toastId = showToast({
      tone: "neutral",
      text: `Deleted "${title}"`,
      action: { label: "Undo", run: () => { settlePendingDelete(id); dismissToast(toastId); } },
    }, DELETE_UNDO_MS);
    // Deleting the open chat lands on a fresh one, as archiving does.
    if (state.chat.activeId === conversationId) await handleNewTask();
  };

  // Chats live in their project, so pending deletes must land before the open project changes.
  const flushPendingDeletes = async (): Promise<void> => {
    await Promise.all([...deleteTimers.current.values()].map((pending) => pending.run()));
  };

  useEffect(() => () => { deleteTimers.current.forEach((pending) => clearTimeout(pending.timer)); }, []);

  const restoreChat = async (conversationId: string): Promise<void> => {
    await send({ type: "chat.unarchive", conversationId });
  };

  const archivedChats = state.chat.conversations.filter((conversation) => conversation.archived && !pendingDeletes.includes(`chat-${conversation.id}`));

  // Search spans every unarchived chat and, with a project open, its tasks.
  const searchCommands: PaletteCommand[] = useMemo(() => [
    ...state.chat.conversations
      .filter((conversation) => !conversation.archived && !pendingDeletes.includes(`chat-${conversation.id}`))
      .map((conversation) => ({ id: `chat-${conversation.id}`, label: conversation.title || "New chat", hint: "Chat", run: () => handleSelectSession(`chat-${conversation.id}`) })),
    ...state.threads
      .filter((thread) => !thread.archived)
      .map((thread) => ({ id: `thread-${thread.id}`, label: thread.title, hint: "Task", run: () => handleSelectSession(`thread-${thread.id}`) })),
  ], [state.chat.conversations, state.threads, pendingDeletes]);

  const handleNewTask = async (): Promise<void> => {
    dispatch({ type: "ui.mode", mode: "chat" });
    updatePrefs({ mode: "chat" });
    const created = await send({ type: "chat.create", input: {} });
    // Chats are saved inside a project, so the backend refuses one until a folder is open.
    if (created.type === "request.failed" && !stateRef.current.repositoryRoot) {
      showToast({ tone: "warning", text: "Open a project to start a chat. Chats are saved inside the project folder." });
    }
  };
  startNewChatRef.current = () => { void handleNewTask(); };

  const shellStatus = [
    state.repositoryRoot
      ? { label: projectName(state.repositoryRoot) }
      : { label: "No workspace" },
    { label: state.mode === "chat" ? "HiveChat" : "Hive Code", emphasis: true },
    { label: activeModelName },
  ];

  async function openRepository(root: string): Promise<void> {
    const value = root.trim(); if (!value) return;
    await flushPendingDeletes();
    const epoch = ++openEpochRef.current;
    repositoryRef.current = null;
    dispatch({ type: "ui.repository-opening" });
    setSaving(false); setComposer(""); closeProviderDialog();
    setBusy(true);
    try {
      const ready = await send({ type: "repository.open", repositoryRoot: value }, { epoch });
      if (epoch === openEpochRef.current && ready.type === "desktop.ready") {
        repositoryRef.current = ready.repositoryRoot;
        await Promise.all([
          send({ type: "repository.list" }, { epoch }),
          send({ type: "thread.list" }, { epoch, repositoryRoot: ready.repositoryRoot }),
          send({ type: "provider.list" }, { epoch }),
          send({ type: "git.inspect", repositoryRoot: ready.repositoryRoot }, { epoch, repositoryRoot: ready.repositoryRoot }),
          send({ type: "chat.list" }, { epoch }),
          send({ type: "workspace.list", input: { repositoryRoot: ready.repositoryRoot } }, { epoch, repositoryRoot: ready.repositoryRoot }),
        ]);
      }
    } finally { if (epoch === openEpochRef.current) setBusy(false); }
  }

  async function pickAndOpenRepository(): Promise<void> {
    const picked = await send({ type: "workspace.pick" });
    if (picked.type === "workspace.picked" && picked.path) await openRepository(picked.path);
  }

  async function loadThread(thread: ThreadRecordV1): Promise<void> {
    const event = await send({ type: "thread.load", threadId: thread.id });
    if (event.type === "thread.changed") {
      const run = latestRun(event.thread);
      if (run && state.repositoryRoot) {
        await send({ type: "run.report", input: { repositoryRoot: state.repositoryRoot, threadId: thread.id, codingSessionId: run.codingSessionId } });
        await send({ type: "changes.diff", input: { repositoryRoot: state.repositoryRoot, codingSessionId: run.codingSessionId } });
      }
    }
  }

  async function createThread(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!newThreadTitle.trim()) return;
    await send({ type: "thread.create", input: { title: newThreadTitle.trim() } });
    setNewThreadTitle("New HIVE task");
  }

  async function submitMessage(event?: FormEvent): Promise<void> {
    if (event) event.preventDefault();
    if (!activeThread || !state.repositoryRoot || !composer.trim() || repositoryActiveRun) return;
    const content = composer.trim();
    setSaving(true);
    try {
      const loaded = await send({ type: "thread.load", threadId: activeThread.id });
      if (loaded.type !== "thread.changed") return;
      const authoritativeRun = latestRun(loaded.thread);
      if (authoritativeRun && !terminalStatuses.has(authoritativeRun.status)) return;
      const message: ThreadMessage = { id: identifier("message"), role: "user", content, createdAt: new Date().toISOString() };
      const persisted = await send({ type: "thread.message.append", input: { threadId: activeThread.id, message } });
      if (persisted.type !== "thread.changed") return;
      setComposer("");
      const started = await send({ type: "run.start", input: { repositoryRoot: state.repositoryRoot, threadId: activeThread.id, currentUserMessageId: message.id, options: { mode: "auto", approvalPolicy: "changes", providerId: state.selectedProviderId || undefined } } });
      setRetryMessageId(started.type === "request.failed" ? message.id : null);
    } catch { setComposer(content); }
    finally { setSaving(false); }
  }

  async function retryRun(messageId: string): Promise<void> {
    if (!activeThread || !state.repositoryRoot || repositoryActiveRun) return;
    setSaving(true);
    try {
      const started = await send({ type: "run.start", input: { repositoryRoot: state.repositoryRoot, threadId: activeThread.id, currentUserMessageId: messageId, options: { mode: "auto", approvalPolicy: "changes", providerId: state.selectedProviderId || undefined } } });
      if (started.type !== "request.failed") setRetryMessageId(null);
    } finally { setSaving(false); }
  }

  async function chooseTab(tab: CenterTab): Promise<void> {
    dispatch({ type: "ui.tab", tab });
    if (!state.repositoryRoot || !activeThread || !sessionId) return;
    if (tab === "changes") await send({ type: "changes.diff", input: { repositoryRoot: state.repositoryRoot, codingSessionId: sessionId } });
    if (tab === "report") await send({ type: "run.report", input: { repositoryRoot: state.repositoryRoot, threadId: activeThread.id, codingSessionId: sessionId } });
  }

  // The Hive Code inspector loads a run's diff and report when their tabs are opened.
  async function loadInspectorTab(tab: InspectorTab): Promise<void> {
    if (!state.repositoryRoot || !activeThread || !sessionId) return;
    if (tab === "changes") await send({ type: "changes.diff", input: { repositoryRoot: state.repositoryRoot, codingSessionId: sessionId } });
    if (tab === "evidence") await send({ type: "run.report", input: { repositoryRoot: state.repositoryRoot, threadId: activeThread.id, codingSessionId: sessionId } });
  }

  async function runAction(type: "pause" | "resume" | "cancel"): Promise<void> {
    if (!state.repositoryRoot || !activeThread || !currentRun) return;
    if (type === "pause") await send({ type: "run.pause", input: { repositoryRoot: state.repositoryRoot, threadId: activeThread.id, codingSessionId: currentRun.codingSessionId } });
    else if (type === "resume") await send({ type: "run.resume", input: { repositoryRoot: state.repositoryRoot, threadId: activeThread.id, codingSessionId: currentRun.codingSessionId, options: { mode: "auto", approvalPolicy: "changes", providerId: state.selectedProviderId || undefined } } });
    else await send({ type: "run.cancel", input: { repositoryRoot: state.repositoryRoot, threadId: activeThread.id, codingSessionId: currentRun.codingSessionId } });
  }

  async function previewGit(action: "commit" | "discard" | "push" | "pull-request"): Promise<void> {
    if (!state.repositoryRoot || !sessionId) return;
    const base = { repositoryRoot: state.repositoryRoot, codingSessionId: sessionId };
    if (action === "commit") await send({ type: "git.commit.preview", input: { ...base, action, message: "HIVE: approve reviewed changes", paths: state.diff?.codingSessionId === sessionId ? state.diff.reviewedFiles : [] } });
    else if (action === "discard") await send({ type: "git.discard.preview", input: { ...base, action } });
    else if (action === "push") await send({ type: "git.push.preview", input: { ...base, action, remote: "origin" } });
    else await send({ type: "git.pull-request.preview", input: { ...base, action, remote: "origin", base: "main", title: activeThread?.title ?? "HIVE changes", body: "Changes reviewed in HIVE Desktop.", draft: true } });
  }

  async function confirmGit(preview: GuardedGitActionPreview): Promise<void> {
    const input = { confirmationToken: preview.confirmationToken, proposal: preview.proposal };
    const type = preview.proposal.action === "pull-request" ? "git.pull-request.confirm" : `git.${preview.proposal.action}.confirm`;
    const result = await send({ type, input } as DesktopCommandInput);
    if (result.type === "request.failed") dispatch({ type: "ui.close-preview" });
  }

  async function storeCredential(event: FormEvent, kind: DesktopCredentialKind, configuration: DesktopProviderConfigurationInput): Promise<void> {
    event.preventDefault(); if (!state.selectedProviderId || !credential) return;
    const providerId = state.selectedProviderId;
    const input = { providerId, kind, secret: credentialRef.current };
    try {
      const configured = await send({ type: "provider.configure", input: configuration });
      if (configured.type === "request.failed") return;
      const setCred = await send({ type: "credential.set", input });
      if (setCred.type !== "request.failed") {
        await fetchModels(providerId);
      }
    }
    finally { input.secret = ""; closeProviderDialog(); }
  }

  async function approveProvider(provider: DesktopProviderMetadata): Promise<void> {
    const configured = await send({ type: "provider.configure", input: { id: provider.id, name: provider.name, kind: provider.kind, authType: provider.authType, ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}), ...(provider.defaultModel ? { defaultModel: provider.defaultModel } : {}), approved: true } });
    if (configured.type !== "request.failed") {
      closeProviderDialog();
      await fetchModels(provider.id);
    }
  }

  const toggleRail = (side: "left" | "right") => {
    // Read through the ref so keyboard handlers bound in earlier renders toggle the live value.
    const rails = stateRef.current.rails;
    const nextRails = { ...rails, [side]: !rails[side] };
    dispatch({ type: "ui.rails", side });
    updatePrefs({ rails: nextRails });
  };

  const handleSplitRatioChange = (ratio: number) => {
    updatePrefs({ splitRatio: ratio });
  };

  // Palette Commands
  const paletteCommands: PaletteCommand[] = useMemo(() => {
    const list: PaletteCommand[] = [];

    list.push({
      id: "project-browse",
      label: "Open project folder...",
      hint: "Browse",
      run: () => void pickAndOpenRepository(),
    });

    state.repositories
      .filter((repo) => repo.path.toLowerCase() !== state.repositoryRoot?.toLowerCase())
      .slice(0, 6)
      .forEach((repo) => {
        list.push({
          id: `repo-${repo.path}`,
          label: `Open project: ${projectName(repo.path)} (${repo.path})`,
          hint: "Recent",
          run: () => void openRepository(repo.path),
        });
      });

    list.push({
      id: "tab-conv",
      label: "Switch to Conversation tab",
      hint: "Ctrl+1",
      run: () => void chooseTab("conversation"),
    });
    list.push({
      id: "tab-changes",
      label: "Switch to Changes diff tab",
      hint: "Ctrl+2",
      run: () => void chooseTab("changes"),
    });
    list.push({
      id: "tab-report",
      label: "Switch to Verified Report tab",
      hint: "Ctrl+3",
      run: () => void chooseTab("report"),
    });

    list.push({
      id: "toggle-left",
      label: "Toggle sidebar",
      hint: "Ctrl+B",
      run: () => toggleRail("left"),
    });

    list.push({
      id: "surface-chat",
      label: "Switch to Chat surface",
      hint: "Surface",
      run: () => {
        dispatch({ type: "ui.mode", mode: "chat" });
        updatePrefs({ mode: "chat" });
      },
    });

    list.push({
      id: "surface-codex",
      label: "Switch to Codex workspace",
      hint: "Surface",
      run: () => {
        dispatch({ type: "ui.mode", mode: "coder" });
        updatePrefs({ mode: "coder" });
      },
    });

    if (activeRun) {
      list.push({
        id: "run-pause",
        label: "Pause active turn",
        hint: "Checkpoint",
        run: () => void runAction("pause"),
      });
    } else if (currentRun?.status === "paused") {
      list.push({
        id: "run-resume",
        label: "Resume paused turn",
        hint: "Resume",
        run: () => void runAction("resume"),
      });
    }

    list.push({
      id: "help-shortcuts",
      label: "View Keyboard Shortcuts",
      hint: "?",
      run: () => setShortcutHelpOpen(true),
    });
    list.push({
      id: "open-settings",
      label: "Open Settings",
      hint: "[*]",
      run: () => {
        setSettingsTab("models");
        setSettingsOpen(true);
      },
    });
    list.push({
      id: "configure-providers",
      label: "Configure providers",
      hint: "API keys",
      run: () => {
        setSettingsTab("models");
        setSettingsOpen(true);
      },
    });

    return list;
  }, [state.repositories, activeRun, currentRun, state.rails, state.repositoryRoot]);

  // Global Keyboard Shortcuts
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (paletteOpen) { setPaletteOpen(false); return; }
        if (searchOpen) { setSearchOpen(false); return; }
        if (deleteTarget) { setDeleteTarget(null); return; }
        if (archivedOpen) { setArchivedOpen(false); return; }
        if (shortcutHelpOpen) { setShortcutHelpOpen(false); return; }
        if (settingsOpen) { setSettingsOpen(false); return; }
        if (providerDialog) { closeProviderDialog(); return; }
        if (state.preview) {
          dispatch({
            type: "git.action-completed",
            timestamp: new Date().toISOString(),
            action: state.preview.proposal.action,
            summary: "Preview closed.",
          });
          return;
        }
      }

      if ((event.ctrlKey || event.metaKey) && (event.key === "k" || event.key === "K")) {
        event.preventDefault();
        setPaletteOpen((prev) => !prev);
        return;
      }

      const meta = event.ctrlKey || event.metaKey;
      const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement || (event.target instanceof HTMLElement && event.target.isContentEditable);
      const inChatComposer = event.target instanceof HTMLElement && event.target.closest(".hive-chat-surface") !== null;
      if (!modalOpen && meta && event.shiftKey && !event.altKey && event.key.toLowerCase() === "o") {
        event.preventDefault();
        startNewChatRef.current();
        return;
      }
      if (!modalOpen && meta && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "n" && (!typing || inChatComposer)) {
        event.preventDefault();
        startNewChatRef.current();
        return;
      }

      if (!modalOpen && meta && event.shiftKey && !event.altKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setSearchOpen(true);
        return;
      }

      if (!modalOpen && meta && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "b") {
        event.preventDefault();
        toggleRail("left");
        return;
      }

      const isInput = typing;

      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        void submitMessage();
        return;
      }

      if (isInput || modalOpen) return;

      if ((event.ctrlKey || event.metaKey) && event.key === "1") {
        event.preventDefault();
        void chooseTab("conversation");
      } else if ((event.ctrlKey || event.metaKey) && event.key === "2") {
        event.preventDefault();
        void chooseTab("changes");
      } else if ((event.ctrlKey || event.metaKey) && event.key === "3") {
        event.preventDefault();
        void chooseTab("report");
      } else if (event.key === "?") {
        event.preventDefault();
        setShortcutHelpOpen(true);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [paletteOpen, searchOpen, deleteTarget, archivedOpen, shortcutHelpOpen, settingsOpen, providerDialog, state.preview, modalOpen, composer, activeThread, state.repositoryRoot, repositoryActiveRun]);

  return (
    <div className="app-shell dual-shell" data-density={prefs.density ?? "comfortable"} data-accent={prefs.accent ?? "vivid"}>
      <a className="skip-link" href="#main-workspace">Skip to workspace</a>
      <Shell
        mode={state.mode}
        onSelectMode={(mode) => {
          dispatch({ type: "ui.mode", mode });
          updatePrefs({ mode });
        }}
        onCreateTask={handleNewTask}
        sessions={recentSessions}
        onSelectSession={handleSelectSession}
        onOpenSearch={() => setSearchOpen(true)}
        onArchiveSession={(id) => void archiveSession(id)}
        onRenameSession={(id, title) => void renameChat(id, title)}
        onDeleteSession={(id) => {
          const session = recentSessions.find((entry) => entry.id === id);
          if (session) setDeleteTarget({ id, title: session.title });
        }}
        starredIds={starredIds}
        onToggleStar={toggleStar}
        onOpenShortcuts={() => setShortcutHelpOpen(true)}
        onOpenArchived={() => setArchivedOpen(true)}
        repositoryPath={state.repositoryRoot ?? ""}
        onOpenRepository={openRepository}
        onPickRepository={pickAndOpenRepository}
        recentProjects={state.repositories}
        busy={busy}
        sidebarOpen={state.rails.left}
        onToggleSidebar={() => toggleRail("left")}
        projectName={state.repositoryRoot ? projectName(state.repositoryRoot) : "HIVE"}
        sessionTabs={sessionTabs}
        activeTabId={activeTabId}
        onSelectTab={handleSelectSession}
        onNewTab={handleNewTask}
        activeModelName={activeModelName}
        onOpenModelPicker={() => { setSettingsTab("catalog"); setSettingsOpen(true); }}
        onOpenSettings={() => { setSettingsTab("models"); setSettingsOpen(true); }}
        onOpenUsage={() => dispatch({ type: "ui.mode", mode: "usage" })}
        worker={state.worker}
        status={shellStatus}
      >
        {state.mode === "chat" ? (
          <ChatSurface
            state={state}
            send={send}
            activeModelName={activeModelName}
            modelOptions={modelOptions}
            selectedModel={modelChoice}
            onSelectModel={(choice) => setModelChoice({ providerId: choice.providerId, model: choice.model })}
            onOpenModelPicker={() => { setSettingsTab("catalog"); setSettingsOpen(true); }}
            onOpenSettings={() => dispatch({ type: "ui.mode", mode: "settings" })}
            onHandoffToCoder={() => dispatch({ type: "ui.mode", mode: "coder" })}
          />
        ) : state.mode === "split" ? (
          <SplitWorkspace
            state={state}
            send={send}
            activeModelName={activeModelName}
            modelOptions={modelOptions}
            selectedModel={modelChoice}
            onSelectModel={(choice) => setModelChoice({ providerId: choice.providerId, model: choice.model })}
            onOpenModelPicker={() => { setSettingsTab("catalog"); setSettingsOpen(true); }}
            onOpenSettings={() => dispatch({ type: "ui.mode", mode: "settings" })}
            onOpenRepositoryPicker={pickAndOpenRepository}
            onSelectFile={async (filePath) => {
              if (!state.repositoryRoot) return;
              dispatch({ type: "ui.preview-file", path: filePath });
              await send({ type: "workspace.read", input: { repositoryRoot: state.repositoryRoot, path: filePath } });
            }}
            onToggleDir={async (dirPath) => {
              if (!state.repositoryRoot || state.workspaceListings[dirPath]) return;
              await send({ type: "workspace.list", input: { repositoryRoot: state.repositoryRoot, path: dirPath } });
            }}
            onPreviewGit={previewGit}
            onLoadThread={async (threadId) => {
              const t = state.threads.find((entry) => entry.id === threadId);
              if (t) void loadThread(t);
            }}
            onHandoffToCoder={() => dispatch({ type: "ui.mode", mode: "coder" })}
          />
        ) : state.mode === "settings" ? (
          <SettingsSurface
            providers={state.providers}
            modelsByProvider={state.modelsByProvider}
            modelsLoading={modelsLoading}
            onFetchModels={fetchModels}
            onConfigureProvider={(providerId) => {
              const provider = state.providers.find((entry) => entry.id === providerId);
              if (provider) {
                clearCredential();
                dispatch({ type: "provider.changed", timestamp: new Date().toISOString(), provider });
                setProviderDialog(true);
              }
            }}
            onAddCompatibleProvider={async (input) => {
              const configured = await send({
                type: "provider.configure",
                input: {
                  id: input.id,
                  name: input.name,
                  kind: "openai-compatible",
                  authType: "api-key",
                  baseUrl: input.baseUrl,
                  defaultModel: input.defaultModel,
                  approved: true,
                },
              });
              if (configured.type !== "request.failed") {
                clearCredential();
                setProviderDialog(true);
              }
            }}
          />
        ) : state.mode === "usage" ? (
          <UsageSurface
            threads={state.threads}
            conversations={state.chat.conversations}
            reports={state.reports}
          />
        ) : (
          <CodexSurface
            state={state}
            send={send}
            activeModelName={activeModelName}
            onOpenModelPicker={() => { setSettingsTab("catalog"); setSettingsOpen(true); }}
            onOpenSettings={() => dispatch({ type: "ui.mode", mode: "settings" })}
            onOpenRepositoryPicker={pickAndOpenRepository}
            onSelectFile={async (filePath) => {
              if (!state.repositoryRoot) return;
              dispatch({ type: "ui.preview-file", path: filePath });
              await send({ type: "workspace.read", input: { repositoryRoot: state.repositoryRoot, path: filePath } });
              if (sessionId && state.diff?.recordedFiles.includes(filePath)) {
                await send({ type: "changes.diff", input: { repositoryRoot: state.repositoryRoot, codingSessionId: sessionId } });
              }
            }}
            onToggleDir={async (dirPath) => {
              if (!state.repositoryRoot || state.workspaceListings[dirPath]) return;
              await send({ type: "workspace.list", input: { repositoryRoot: state.repositoryRoot, path: dirPath } });
            }}
            onPreviewGit={previewGit}
            onRunAction={runAction}
            onSelectInspectorTab={(tab) => void loadInspectorTab(tab)}
            onLoadThread={async (threadId) => {
              const t = state.threads.find((entry) => entry.id === threadId);
              if (t) void loadThread(t);
            }}
          />
        )}
      </Shell>

      <Toast toasts={toasts} onDismiss={dismissToast} />

      <div className="announcer" aria-live="polite" aria-atomic="true" aria-hidden={modalOpen || undefined}>
        {saving ? "Saving message..." : state.notice}
      </div>

      {stickyError && (
        <div className="error-toast" role="alert">
          <span>{stickyError}</span>
          <button
            type="button"
            aria-label="Dismiss error"
            onClick={() => {
              setStickyError(null);
              dispatch({ type: "ui.dismiss-error" });
            }}
          >
            Dismiss
          </button>
        </div>
      )}

      {state.preview && (
        <ConfirmationDialog
          preview={state.preview}
          onCancel={() => dispatch({ type: "git.action-completed", timestamp: new Date().toISOString(), action: state.preview!.proposal.action, summary: "Preview closed." })}
          onConfirm={confirmGit}
        />
      )}

      {providerDialog && (
        <ProviderDialog
          provider={state.providers.find((item) => item.id === state.selectedProviderId)}
          credential={credential}
          onCredential={(value) => { credentialRef.current = value; setCredential(value); }}
          onClose={closeProviderDialog}
          onSubmit={storeCredential}
          onApprove={approveProvider}
        />
      )}

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        commands={paletteCommands}
      />

      <CommandPalette
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        commands={searchCommands}
        label="Search chats"
        inputLabel="Search chats and tasks"
        placeholder="Search chats and tasks..."
        emptyText="No matching chats or tasks"
      />

      {archivedOpen && (
        <Dialog title="Archived chats" onClose={() => setArchivedOpen(false)} className="archived-dialog">
          {archivedChats.length === 0 ? (
            <p className="archived-empty">No archived chats in this project.</p>
          ) : (
            <ul className="archived-list" aria-label="Archived chats">
              {archivedChats.map((conversation) => (
                <li key={conversation.id} className="archived-row">
                  <span className="archived-title" title={conversation.title}>{conversation.title || "New chat"}</span>
                  <button type="button" onClick={() => void restoreChat(conversation.id)} aria-label={`Restore ${conversation.title || "New chat"}`}>Restore</button>
                  <button type="button" className="danger" onClick={() => setDeleteTarget({ id: `chat-${conversation.id}`, title: conversation.title || "New chat" })} aria-label={`Delete ${conversation.title || "New chat"}`}>Delete</button>
                </li>
              ))}
            </ul>
          )}
          <div className="dialog-actions">
            <button type="button" onClick={() => setArchivedOpen(false)}>Close</button>
          </div>
        </Dialog>
      )}

      {deleteTarget && (
        <Dialog title="Delete chat?" onClose={() => setDeleteTarget(null)} initialFocus="first">
          <p>
            This will permanently delete <strong>{deleteTarget.title}</strong>. You can undo for a few seconds afterwards; archive it instead to keep a copy.
          </p>
          <div className="dialog-actions">
            <button type="button" onClick={() => setDeleteTarget(null)}>Cancel</button>
            <button type="button" className="danger" onClick={() => void confirmDeleteChat()}>Delete</button>
          </div>
        </Dialog>
      )}

      {shortcutHelpOpen && (
        <ShortcutHelp onClose={() => setShortcutHelpOpen(false)} />
      )}

      {settingsOpen && (
        <SettingsDialog
          onClose={() => setSettingsOpen(false)}
          initialTab={settingsTab}
          providers={state.providers}
          modelsByProvider={state.modelsByProvider}
          modelsLoading={modelsLoading}
          onFetchModels={fetchModels}
          onConfigureProvider={(providerId) => {
            const provider = state.providers.find((entry) => entry.id === providerId);
            if (provider) {
              clearCredential();
              dispatch({ type: "provider.changed", timestamp: new Date().toISOString(), provider });
              setSettingsOpen(false);
              setProviderDialog(true);
            }
          }}
          onAddCompatibleProvider={async (input) => {
            const configured = await send({
              type: "provider.configure",
              input: {
                id: input.id,
                name: input.name,
                kind: "openai-compatible",
                authType: "api-key",
                baseUrl: input.baseUrl,
                defaultModel: input.defaultModel,
                approved: true,
              },
            });
            if (configured.type === "request.failed") return;
            clearCredential();
            setSettingsOpen(false);
            setProviderDialog(true);
          }}
        />
      )}
    </div>
  );
}
