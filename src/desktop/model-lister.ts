import type { DesktopModelInfo, DesktopProviderMetadata, ResolvedDesktopCredential } from "./types.js";

const DEFAULT_TIMEOUT_MS = 8_000;

const KNOWN_ANTHROPIC_MODELS: DesktopModelInfo[] = [
  { id: "claude-opus-4.7", name: "Claude Opus 4.7", contextWindow: 200_000, ownedBy: "Anthropic" },
  { id: "claude-opus-4.6", name: "Claude Opus 4.6", contextWindow: 200_000, ownedBy: "Anthropic" },
  { id: "claude-opus-4.5", name: "Claude Opus 4.5", contextWindow: 200_000, ownedBy: "Anthropic" },
  { id: "claude-sonnet-5", name: "Claude Sonnet 5", contextWindow: 200_000, ownedBy: "Anthropic" },
  { id: "claude-sonnet-4.6", name: "Claude Sonnet 4.6", contextWindow: 200_000, ownedBy: "Anthropic" },
  { id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5", contextWindow: 200_000, ownedBy: "Anthropic" },
  { id: "claude-haiku-4.5", name: "Claude Haiku 4.5", contextWindow: 200_000, ownedBy: "Anthropic" },
  { id: "claude-3-5-sonnet-latest", name: "Claude 3.5 Sonnet", contextWindow: 200_000, ownedBy: "Anthropic" },
  { id: "claude-3-5-haiku-latest", name: "Claude 3.5 Haiku", contextWindow: 200_000, ownedBy: "Anthropic" },
];

const KNOWN_GOOGLE_MODELS: DesktopModelInfo[] = [
  { id: "gemini-3-flash", name: "Gemini 3 Flash", contextWindow: 1_000_000, ownedBy: "Google" },
  { id: "gemini-3.1-pro-preview", name: "Gemini 3.1 Pro Preview", contextWindow: 1_000_000, ownedBy: "Google" },
  { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", contextWindow: 1_000_000, ownedBy: "Google" },
  { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", contextWindow: 1_000_000, ownedBy: "Google" },
  { id: "gemini-2.0-flash", name: "Gemini 2.0 Flash", contextWindow: 1_000_000, ownedBy: "Google" },
  { id: "gemini-1.5-pro", name: "Gemini 1.5 Pro", contextWindow: 2_000_000, ownedBy: "Google" },
];

function sortModels(models: DesktopModelInfo[]): DesktopModelInfo[] {
  return [...models].sort((a, b) => a.id.localeCompare(b.id));
}

function defaultModelFallback(provider: DesktopProviderMetadata): DesktopModelInfo[] {
  if (!provider.defaultModel) return [];
  return [{ id: provider.defaultModel, name: provider.defaultModel, ownedBy: provider.name }];
}

function publishableModels(models: DesktopModelInfo[]): DesktopModelInfo[] {
  return sortModels(models.flatMap((model) => {
    if (!model.id || model.id.length > 256 || model.id.includes("\0")) return [];
    const name = model.name && model.name.length <= 256 && !model.name.includes("\0") ? model.name : undefined;
    const ownedBy = model.ownedBy && model.ownedBy.length <= 256 && !model.ownedBy.includes("\0") ? model.ownedBy : undefined;
    const contextWindow = typeof model.contextWindow === "number"
      && Number.isSafeInteger(model.contextWindow)
      && model.contextWindow >= 1
      && model.contextWindow <= 100_000_000
      ? model.contextWindow
      : undefined;
    return [{
      id: model.id,
      ...(name ? { name } : {}),
      ...(contextWindow ? { contextWindow } : {}),
      ...(ownedBy ? { ownedBy } : {}),
    }];
  }));
}

export class DesktopModelLister {
  public static async list(
    provider: DesktopProviderMetadata,
    credential?: ResolvedDesktopCredential | null,
    fetchFn: typeof fetch = fetch,
  ): Promise<DesktopModelInfo[]> {
    if (provider.kind === "anthropic") {
      return publishableModels(await this.#listAnthropic(provider, credential, fetchFn));
    }
    if (provider.kind === "google") {
      return publishableModels(await this.#listGoogle(provider, credential, fetchFn));
    }
    if (provider.kind === "local") {
      return publishableModels(defaultModelFallback(provider));
    }
    if (provider.kind === "ollama") {
      return publishableModels(await this.#listOllama(provider, fetchFn));
    }

    return publishableModels(await this.#listOpenAiCompatible(provider, credential, fetchFn));
  }

  static async #listAnthropic(
    _provider: DesktopProviderMetadata,
    credential: ResolvedDesktopCredential | null | undefined,
    fetchFn: typeof fetch,
  ): Promise<DesktopModelInfo[]> {
    const token = credential?.secret;
    if (!token) {
      return KNOWN_ANTHROPIC_MODELS;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

    try {
      const res = await fetchFn("https://api.anthropic.com/v1/models", {
        method: "GET",
        headers: {
          "x-api-key": token,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        signal: controller.signal,
      });

      if (!res.ok) {
        return KNOWN_ANTHROPIC_MODELS;
      }

      const body = await res.json() as { data?: unknown } | null;
      const list = body && typeof body === "object" && Array.isArray((body as { data?: unknown }).data)
        ? (body as { data: unknown[] }).data
        : [];

      const models: DesktopModelInfo[] = [];
      for (const item of list) {
        if (!item || typeof item !== "object") continue;
        const record = item as Record<string, unknown>;
        const id = typeof record.id === "string" ? record.id : "";
        if (!id) continue;
        const displayName = typeof record.display_name === "string" && record.display_name
          ? record.display_name
          : typeof record.name === "string" && record.name
            ? record.name
            : id;
        models.push({
          id,
          name: displayName,
          contextWindow: 200_000,
          ownedBy: "Anthropic",
        });
      }

      return models.length > 0 ? models : KNOWN_ANTHROPIC_MODELS;
    } catch {
      return KNOWN_ANTHROPIC_MODELS;
    } finally {
      clearTimeout(timer);
    }
  }

  static async #listGoogle(
    _provider: DesktopProviderMetadata,
    credential: ResolvedDesktopCredential | null | undefined,
    fetchFn: typeof fetch,
  ): Promise<DesktopModelInfo[]> {
    const token = credential?.secret;
    if (!token) {
      return KNOWN_GOOGLE_MODELS;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(token)}`;
      const res = await fetchFn(url, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
        },
        signal: controller.signal,
      });

      if (!res.ok) {
        return KNOWN_GOOGLE_MODELS;
      }

      const body = await res.json() as { models?: unknown } | null;
      const list = body && typeof body === "object" && Array.isArray((body as { models?: unknown }).models)
        ? (body as { models: unknown[] }).models
        : [];

      const models: DesktopModelInfo[] = [];
      for (const item of list) {
        if (!item || typeof item !== "object") continue;
        const record = item as Record<string, unknown>;
        const rawName = typeof record.name === "string" ? record.name : "";
        if (!rawName) continue;
        const id = rawName.replace(/^models\//, "");
        const lowerId = id.toLowerCase();
        if (lowerId.includes("embedding") || lowerId.includes("aqa")) {
          continue;
        }
        const displayName = typeof record.displayName === "string" && record.displayName
          ? record.displayName
          : id;
        const contextWindow = typeof record.inputTokenLimit === "number" && record.inputTokenLimit > 0
          ? record.inputTokenLimit
          : 1_000_000;

        models.push({
          id,
          name: displayName,
          contextWindow,
          ownedBy: "Google",
        });
      }

      return models.length > 0 ? models : KNOWN_GOOGLE_MODELS;
    } catch {
      return KNOWN_GOOGLE_MODELS;
    } finally {
      clearTimeout(timer);
    }
  }

  static async #listOllama(
    provider: DesktopProviderMetadata,
    fetchFn: typeof fetch,
  ): Promise<DesktopModelInfo[]> {
    const baseUrl = (provider.baseUrl || "http://127.0.0.1:11434").replace(/\/+$/, "");
    const url = `${baseUrl}/api/tags`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

    try {
      const res = await fetchFn(url, {
        method: "GET",
        signal: controller.signal,
      });
      if (!res.ok) return [];

      const data = (await res.json()) as { models?: Array<{ name?: string; model?: string }> };
      if (!data || !Array.isArray(data.models)) return [];

      const models: DesktopModelInfo[] = [];
      for (const item of data.models) {
        const id = item.name || item.model || "";
        if (!id) continue;
        models.push({
          id,
          name: id,
          contextWindow: 131_072,
          ownedBy: "Ollama (local)",
        });
      }

      models.sort((a, b) => a.id.localeCompare(b.id));
      return models;
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  static async #listOpenAiCompatible(
    provider: DesktopProviderMetadata,
    credential: ResolvedDesktopCredential | null | undefined,
    fetchFn: typeof fetch,
  ): Promise<DesktopModelInfo[]> {
    const rawBaseUrl = provider.baseUrl
      || (provider.kind === "openrouter" || provider.id === "openrouter" ? "https://openrouter.ai/api/v1" : "")
      || (provider.kind === "openai" || provider.id === "openai" ? "https://api.openai.com/v1" : "");
    if (!rawBaseUrl) {
      return defaultModelFallback(provider);
    }
    const baseUrl = rawBaseUrl.replace(/\/+$/, "");
    const url = `${baseUrl}/models`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    const token = credential?.secret;
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

    try {
      const res = await fetchFn(url, {
        method: "GET",
        headers,
        signal: controller.signal,
      });

      if (!res.ok) {
        // If unauthenticated or failing, fallback to default model if configured
        return provider.defaultModel
          ? [{ id: provider.defaultModel, name: provider.defaultModel, contextWindow: 128_000, ownedBy: provider.name }]
          : [];
      }

      const body = await res.json() as { data?: unknown } | unknown[] | null;
      const list: unknown[] = Array.isArray(body)
        ? body
        : body && typeof body === "object" && Array.isArray((body as { data?: unknown }).data)
          ? (body as { data: unknown[] }).data
          : [];

      const models: DesktopModelInfo[] = [];
      for (const item of list) {
        if (!item) continue;
        const id = typeof item === "string"
          ? item
          : typeof item === "object" && item && typeof (item as { id?: unknown }).id === "string"
            ? (item as { id: string }).id
            : "";
        if (!id) continue;
        const record = typeof item === "object" && item ? item as Record<string, unknown> : {};
        const contextWindow = [record.context_length, record.context_window, record.max_tokens]
          .find((value) => typeof value === "number") ?? (id.includes("1m") ? 1_000_000 : 128_000);

        models.push({
          id,
          name: typeof record.name === "string" && record.name ? record.name : id,
          contextWindow: typeof contextWindow === "number" ? contextWindow : 128_000,
          ownedBy: typeof record.owned_by === "string" && record.owned_by ? record.owned_by : provider.name,
        });
      }

      models.sort((a, b) => a.id.localeCompare(b.id));

      if (models.length === 0 && provider.defaultModel) {
        models.push({
          id: provider.defaultModel,
          name: provider.defaultModel,
          contextWindow: 128_000,
          ownedBy: provider.name,
        });
      }

      return models;
    } catch {
      return provider.defaultModel
        ? [{ id: provider.defaultModel, name: provider.defaultModel, contextWindow: 128_000, ownedBy: provider.name }]
        : [];
    } finally {
      clearTimeout(timer);
    }
  }
}
