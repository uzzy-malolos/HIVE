import { FormEvent, useEffect, useState } from "react";
import type { DesktopModelInfo, DesktopProviderMetadata } from "../../../../../src/desktop/types";
import { usePrefs } from "../../prefs";

export interface SettingsSurfaceProps {
  initialTab?: "general" | "appearance" | "providers" | "roles" | "security" | "keyboard" | "about";
  providers?: DesktopProviderMetadata[];
  modelsByProvider?: Record<string, DesktopModelInfo[]>;
  modelsLoading?: Record<string, boolean>;
  onFetchModels?: (providerId: string) => void;
  onConfigureProvider?: (providerId: string) => void;
  onAddCompatibleProvider?: (input: { id: string; name: string; baseUrl: string; defaultModel: string }) => Promise<void>;
  onClose?: () => void;
}

export function SettingsSurface({
  initialTab = "providers",
  providers = [],
  modelsByProvider = {},
  modelsLoading = {},
  onFetchModels,
  onConfigureProvider,
  onAddCompatibleProvider,
  onClose,
}: SettingsSurfaceProps) {
  const { prefs, updatePrefs } = usePrefs();
  const [navTab, setNavTab] = useState(initialTab);
  const [selectedProviderId, setSelectedProviderId] = useState<string>(
    providers[0]?.id || "openrouter"
  );
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [defaultModel, setDefaultModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [addingProvider, setAddingProvider] = useState(false);

  const density = prefs.density ?? "comfortable";
  const accent = prefs.accent ?? "vivid";
  const notifications = prefs.notifications ?? true;
  const enabledModels = prefs.enabledModels ?? {};

  useEffect(() => {
    if (selectedProviderId && onFetchModels) {
      const p = providers.find((entry) => entry.id === selectedProviderId);
      if (p && p.configured && !modelsByProvider[p.id] && !modelsLoading[p.id]) {
        void Promise.resolve(onFetchModels(p.id)).catch(() => undefined);
      }
    }
  }, [selectedProviderId, providers]);

  const activeProvider = providers.find((p) => p.id === selectedProviderId) || providers[0];
  const activeModels = activeProvider ? modelsByProvider[activeProvider.id] || [] : [];

  function toggleModel(modelId: string): void {
    const isCurrentlyEnabled = enabledModels[modelId] !== false;
    updatePrefs({ enabledModels: { ...enabledModels, [modelId]: !isCurrentlyEnabled } });
  }

  async function handleAddProvider(e: FormEvent) {
    e.preventDefault();
    if (!onAddCompatibleProvider || !name.trim() || !baseUrl.trim() || !defaultModel.trim()) return;
    setBusy(true);
    try {
      const id = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "custom";
      await onAddCompatibleProvider({
        id,
        name: name.trim(),
        baseUrl: baseUrl.trim().replace(/\/+$/, ""),
        defaultModel: defaultModel.trim(),
      });
      setName("");
      setBaseUrl("");
      setDefaultModel("");
      setAddingProvider(false);
      setSelectedProviderId(id);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="hive-settings-workspace" data-testid="settings-surface">
      {/* Master Column 1: Settings Navigation */}
      <nav className="hive-settings-nav" aria-label="Settings navigation">
        <div className="hive-settings-nav-title">Settings</div>
        <button
          type="button"
          className={`hive-settings-nav-item ${navTab === "general" ? "is-active" : ""}`}
          onClick={() => setNavTab("general")}
        >
          General
        </button>
        <button
          type="button"
          className={`hive-settings-nav-item ${navTab === "appearance" ? "is-active" : ""}`}
          onClick={() => setNavTab("appearance")}
        >
          Appearance
        </button>
        <button
          type="button"
          className={`hive-settings-nav-item ${navTab === "providers" ? "is-active" : ""}`}
          onClick={() => setNavTab("providers")}
        >
          Providers & Models
        </button>
        <button
          type="button"
          className={`hive-settings-nav-item ${navTab === "roles" ? "is-active" : ""}`}
          onClick={() => setNavTab("roles")}
        >
          Agent Roles
        </button>
        <button
          type="button"
          className={`hive-settings-nav-item ${navTab === "security" ? "is-active" : ""}`}
          onClick={() => setNavTab("security")}
        >
          Security & DPAPI
        </button>
        <button
          type="button"
          className={`hive-settings-nav-item ${navTab === "keyboard" ? "is-active" : ""}`}
          onClick={() => setNavTab("keyboard")}
        >
          Keyboard Shortcuts
        </button>
        <button
          type="button"
          className={`hive-settings-nav-item ${navTab === "about" ? "is-active" : ""}`}
          onClick={() => setNavTab("about")}
        >
          About
        </button>
      </nav>

      {/* Surface Detail Views */}
      {navTab === "providers" && (
        <>
          {/* Master Column 2: Provider List */}
          <div className="hive-providers-master">
            <div className="hive-sidebar-label">Configured Providers</div>
            <div className="hive-providers-list">
              {providers.map((p) => {
                const isSelected = p.id === selectedProviderId;
                return (
                  <button
                    key={p.id}
                    type="button"
                    className={`hive-provider-item ${isSelected ? "is-selected" : ""}`}
                    onClick={() => { setSelectedProviderId(p.id); setAddingProvider(false); }}
                  >
                    <span>{p.name}</span>
                    <span className={`hive-provider-status-dot ${p.configured ? "is-configured" : ""}`} />
                  </button>
                );
              })}
            </div>

            <button
              type="button"
              className="hive-btn-secondary"
              style={{ marginTop: "auto", width: "100%" }}
              onClick={() => setAddingProvider(true)}
            >
              + Add Compatible Provider
            </button>
          </div>

          {/* Detail Column 3: Configuration & Model Catalog */}
          <div className="hive-provider-detail">
            {addingProvider ? (
              <form onSubmit={handleAddProvider} style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                <div className="hive-detail-header">
                  <div className="hive-detail-title">Add OpenAI-Compatible Provider</div>
                  <div className="hive-detail-desc">Connect any local or self-hosted endpoint supporting OpenAI format.</div>
                </div>

                <div className="hive-form-group">
                  <label className="hive-form-label">Provider Name</label>
                  <input
                    className="hive-form-input"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. Local vLLM, DeepSeek API"
                    required
                  />
                </div>

                <div className="hive-form-group">
                  <label className="hive-form-label">Base URL</label>
                  <input
                    className="hive-form-input"
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    placeholder="http://localhost:8000/v1"
                    required
                  />
                </div>

                <div className="hive-form-group">
                  <label className="hive-form-label">Default Model ID</label>
                  <input
                    className="hive-form-input"
                    value={defaultModel}
                    onChange={(e) => setDefaultModel(e.target.value)}
                    placeholder="deepseek-ai/deepseek-coder"
                    required
                  />
                </div>

                <div style={{ display: "flex", gap: "8px", marginTop: "8px" }}>
                  <button type="submit" className="hive-btn-commit" style={{ maxWidth: "160px" }} disabled={busy}>
                    {busy ? "Saving..." : "Save Provider"}
                  </button>
                  <button type="button" className="hive-btn-secondary" onClick={() => setAddingProvider(false)}>
                    Cancel
                  </button>
                </div>
              </form>
            ) : activeProvider ? (
              <>
                <div className="hive-detail-header">
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <div className="hive-detail-title">{activeProvider.name}</div>
                    <button
                      type="button"
                      className="hive-btn-secondary"
                      onClick={() => onConfigureProvider?.(activeProvider.id)}
                    >
                      {activeProvider.configured ? "Update API Key" : "Configure Key"}
                    </button>
                  </div>
                  <div className="hive-detail-desc">
                    {activeProvider.configured
                      ? "Configured with Windows DPAPI Key Vault encryption."
                      : "API key not configured."}
                  </div>
                </div>

                {activeProvider.baseUrl && (
                  <div className="hive-form-group">
                    <label className="hive-form-label">Base URL</label>
                    <input className="hive-form-input" value={activeProvider.baseUrl} readOnly />
                  </div>
                )}

                <div className="hive-form-group" style={{ maxWidth: "100%" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "6px" }}>
                    <label className="hive-form-label">Available Models ({activeModels.length})</label>
                    {onFetchModels && (
                      <button
                        type="button"
                        className="hive-badge is-violet"
                        onClick={() => onFetchModels(activeProvider.id)}
                        disabled={modelsLoading[activeProvider.id]}
                      >
                        {modelsLoading[activeProvider.id] ? "Discovering..." : "Refresh Models"}
                      </button>
                    )}
                  </div>

                  {activeModels.length > 0 ? (
                    <table className="hive-models-table">
                      <thead>
                        <tr>
                          <th>Model</th>
                          <th>Context Window</th>
                          <th>Status</th>
                          <th>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {activeModels.map((m) => {
                          const isEnabled = enabledModels[m.id] !== false;
                          return (
                            <tr key={m.id}>
                              <td className="hive-model-id-cell">{m.name || m.id}</td>
                              <td className="hive-mono">{m.contextWindow ? `${Math.round(m.contextWindow / 1000)}K` : "Default"}</td>
                              <td>
                                <span className={`hive-badge ${isEnabled ? "is-success" : "is-warning"}`}>
                                  {isEnabled ? "Enabled" : "Disabled"}
                                </span>
                              </td>
                              <td>
                                <button
                                  type="button"
                                  className="hive-badge"
                                  onClick={() => toggleModel(m.id)}
                                >
                                  {isEnabled ? "Disable" : "Enable"}
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  ) : (
                    <div style={{ fontSize: "12px", color: "var(--hive-text-dim)", padding: "12px 0" }}>
                      {modelsLoading[activeProvider.id]
                        ? "Discovering available models from endpoint..."
                        : "No discovered models. Configure API key and click Refresh Models."}
                    </div>
                  )}
                </div>
              </>
            ) : null}
          </div>
        </>
      )}

      {navTab === "general" && (
        <div className="hive-provider-detail">
          <div className="hive-detail-header">
            <div className="hive-detail-title">General Preferences</div>
            <div className="hive-detail-desc">Application behavior and workspace settings.</div>
          </div>
          <div className="hive-form-group">
            <label className="hive-form-label">Composer Send Mode</label>
            <div style={{ display: "flex", gap: "8px", marginTop: "4px" }}>
              <button
                type="button"
                className={`hive-btn-secondary ${prefs.composerSendWithEnter !== false ? "is-active" : ""}`}
                onClick={() => updatePrefs({ composerSendWithEnter: true })}
              >
                Enter to send (Shift+Enter for newline)
              </button>
              <button
                type="button"
                className={`hive-btn-secondary ${prefs.composerSendWithEnter === false ? "is-active" : ""}`}
                onClick={() => updatePrefs({ composerSendWithEnter: false })}
              >
                Ctrl+Enter to send
              </button>
            </div>
          </div>
        </div>
      )}

      {navTab === "appearance" && (
        <div className="hive-provider-detail">
          <div className="hive-detail-header">
            <div className="hive-detail-title">Appearance & Geometry</div>
            <div className="hive-detail-desc">Visual density and theme accents.</div>
          </div>
          <div className="hive-form-group">
            <label className="hive-form-label">Interface Density</label>
            <div style={{ display: "flex", gap: "8px", marginTop: "4px" }}>
              <button
                type="button"
                className={`hive-btn-secondary ${density === "compact" ? "is-active" : ""}`}
                onClick={() => updatePrefs({ density: "compact" })}
              >
                Compact (High density)
              </button>
              <button
                type="button"
                className={`hive-btn-secondary ${density === "comfortable" ? "is-active" : ""}`}
                onClick={() => updatePrefs({ density: "comfortable" })}
              >
                Comfortable (Default)
              </button>
            </div>
          </div>
        </div>
      )}

      {navTab === "security" && (
        <div className="hive-provider-detail">
          <div className="hive-detail-header">
            <div className="hive-detail-title">Security & Key Vault</div>
            <div className="hive-detail-desc">Hardware-backed cryptographic protection on Windows.</div>
          </div>
          <div className="hive-evidence-card">
            <div className="hive-verdict-banner is-accepted">
              <span>DPAPI Vault Active</span>
              <span>Protected</span>
            </div>
            <div className="hive-evidence-rows">
              <div className="hive-evidence-row">
                <span>Encryption Standard</span>
                <span className="hive-evidence-val is-pass">Windows CryptProtectData (DPAPI)</span>
              </div>
              <div className="hive-evidence-row">
                <span>Storage Location</span>
                <span className="hive-evidence-val">Local AppData Vault</span>
              </div>
              <div className="hive-evidence-row">
                <span>Network Transmission</span>
                <span className="hive-evidence-val is-pass">Direct BYOK only (Zero HIVE servers)</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {navTab === "keyboard" && (
        <div className="hive-provider-detail">
          <div className="hive-detail-header">
            <div className="hive-detail-title">Keyboard Shortcuts</div>
            <div className="hive-detail-desc">Quick desktop acceleration commands.</div>
          </div>
          <table className="hive-models-table">
            <thead>
              <tr>
                <th>Shortcut</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              <tr><td className="hive-mono">Ctrl + K</td><td>Open Command & Session Palette</td></tr>
              <tr><td className="hive-mono">Ctrl + 1</td><td>Switch to HiveChat</td></tr>
              <tr><td className="hive-mono">Ctrl + 2</td><td>Switch to Hive Code</td></tr>
              <tr><td className="hive-mono">Ctrl + Tab</td><td>Cycle Open Session Tabs</td></tr>
              <tr><td className="hive-mono">Escape</td><td>Close Open Overlay / Dialog</td></tr>
            </tbody>
          </table>
        </div>
      )}

      {navTab === "about" && (
        <div className="hive-provider-detail">
          <div className="hive-detail-header">
            <div className="hive-detail-title">About HIVE</div>
            <div className="hive-detail-desc">Hyper Intelligence for Verified Engineering.</div>
          </div>
          <div className="hive-evidence-rows" style={{ maxWidth: "480px" }}>
            <div className="hive-evidence-row"><span>Version</span><span className="hive-mono">0.6.0</span></div>
            <div className="hive-evidence-row"><span>Runtime</span><span className="hive-mono">Electron + Node.js 22</span></div>
            <div className="hive-evidence-row"><span>License</span><span>MIT License</span></div>
          </div>
        </div>
      )}
    </div>
  );
}
