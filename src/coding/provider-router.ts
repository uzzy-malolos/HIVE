import os from "node:os";
import { redactSecrets } from "../runner.js";
import { ProviderRegistry } from "../providers/registry.js";
import type {
  ProviderAdapter,
  ProviderCompletionResult,
  ProviderConfig,
  ProviderHealthResult,
  ProviderRoles,
  RoleAssignment,
  ProviderImageInput,
} from "../providers/types.js";
import type { AgentCompletionClient, AgentCompletionResponse } from "./agent-loop.js";
import type {
  ProviderBinding,
  ProviderBindingRole,
  SubagentRole,
} from "./types.js";

export interface ProviderRegistryLike {
  get(id: string): Promise<ProviderConfig | undefined>;
  getRoles(): Promise<ProviderRoles>;
  test(id: string, signal?: AbortSignal): Promise<ProviderHealthResult>;
  getAdapter(id: string): Promise<{
    adapter: ProviderAdapter;
    config: ProviderConfig;
  }>;
}

export interface ProviderOverride {
  providerId?: string;
  model?: string;
  fallbackProviderId?: string;
  fallbackModel?: string;
  /** Explicit opt-out for user-approved requests that must stay on one route. */
  allowFallback?: boolean;
}

export interface RoutedProviderCompletionRequest {
  role: ProviderBindingRole;
  providerId?: string;
  model?: string;
  fallbackProviderId?: string;
  fallbackModel?: string;
  allowFallback?: boolean;
  maxOutputTokens?: number;
  systemPrompt?: string;
  prompt: string;
  cwd?: string;
  signal?: AbortSignal;
  images?: readonly ProviderImageInput[];
}

export interface ResolvedProviderRoute {
  role: ProviderBindingRole;
  providerId: string;
  model: string;
  source: "explicit" | "session" | "project" | "global" | "fallback";
  registryScope: "project" | "global";
  degraded: boolean;
  config: ProviderConfig;
  adapter: ProviderAdapter;
}

export interface ProviderRouterOptions {
  projectRoot: string;
  sessionId: string;
  sessionBindings?: readonly ProviderBinding[];
  cliOverrides?: Partial<Record<ProviderBindingRole, ProviderOverride>>;
  projectRegistry?: ProviderRegistryLike;
  globalRegistry?: ProviderRegistryLike;
  onDegradedRoute?: (route: ResolvedProviderRoute, failures: readonly string[]) => void;
}

interface RouteCandidate {
  role: ProviderBindingRole;
  providerId: string;
  model?: string;
  source: ResolvedProviderRoute["source"];
  fallbackProviderId?: string;
  fallbackModel?: string;
}

interface LocatedProvider {
  registry: ProviderRegistryLike;
  registryScope: ResolvedProviderRoute["registryScope"];
  config: ProviderConfig;
}

function abortError(): Error {
  const error = new Error("Provider request cancelled.");
  error.name = "AbortError";
  return error;
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

async function withAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  assertNotAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function roleAssignment(roles: ProviderRoles, role: ProviderBindingRole): RoleAssignment | undefined {
  return roles[role];
}

function candidateFromBinding(
  binding: ProviderBinding,
  source: RouteCandidate["source"],
): RouteCandidate {
  return {
    role: binding.role,
    providerId: binding.providerId,
    model: binding.model,
    source,
    fallbackProviderId: binding.fallbackProviderId,
    fallbackModel: binding.fallbackModel,
  };
}

function candidateFromAssignment(
  role: ProviderBindingRole,
  assignment: RoleAssignment,
  source: RouteCandidate["source"],
): RouteCandidate {
  return {
    role,
    providerId: assignment.provider,
    model: assignment.model,
    source,
  };
}

function completionUsage(result: ProviderCompletionResult): AgentCompletionResponse["usage"] {
  if (!result.usage) return undefined;
  return {
    input: result.usage.promptTokens,
    output: result.usage.completionTokens,
    total: result.usage.totalTokens,
  };
}

function captureCredentialLiterals(config: ProviderConfig, literals: Set<string>): void {
  const references = [config.apiKeyEnv, config.tokenEnv];
  // Match only the legacy default that this native adapter actually selects.
  if (!config.apiKeyEnv) {
    if (config.kind === "openai") references.push("OPENAI_API_KEY");
    else if (config.kind === "openrouter") references.push("OPENROUTER_API_KEY");
    else if (config.kind === "anthropic") references.push("ANTHROPIC_API_KEY");
    else if (config.kind === "google" && config.apiKeyEnv === undefined && config.tokenEnv === undefined) {
      references.push(process.env.GEMINI_API_KEY !== undefined ? "GEMINI_API_KEY" : "GOOGLE_API_KEY");
    }
  }
  for (const reference of references) {
    const secret = reference ? process.env[reference] : undefined;
    if (!secret) continue;
    literals.add(secret);
    literals.add(JSON.stringify(secret).slice(1, -1));
    try {
      for (const encoded of [encodeURIComponent(secret), encodeURI(secret)]) {
        literals.add(encoded);
        literals.add(encoded.replace(/%[A-F0-9]{2}/gu, (escape) => escape.toLowerCase()));
      }
    } catch { /* A malformed Unicode value still has raw and JSON protection. */ }
  }
}

function safeFailure(error: unknown, literals: ReadonlySet<string>, images?: readonly ProviderImageInput[]): string {
  return publicCompletionText(error instanceof Error ? error.message : String(error), literals, images);
}

/** Submitted credentials and image bytes are request-only, including server echoes. */
function publicCompletionText(value: string, literals: ReadonlySet<string>, images: readonly ProviderImageInput[] = []): string {
  return redactSecrets(privateTextParts(value, literals, images, false).output);
}

function privateTextParts(value: string, literals: ReadonlySet<string>, images: readonly ProviderImageInput[], streaming: boolean): { output: string; pending: string } {
  const replacements = [
    ...images.map((image) => ({ literal: image.data, replacement: "[IMAGE DATA REDACTED]" })),
    ...Array.from(literals, (literal) => ({ literal, replacement: "[REDACTED]" })),
  ].filter(({ literal }) => literal.length > 0).sort((left, right) => right.literal.length - left.literal.length);
  if (replacements.length === 0) return { output: value, pending: "" };
  let output = "";
  let index = 0;
  while (index < value.length) {
    // Hold the raw suffix before replacement: overlapping literals must never
    // expose a longer secret's prefix or alter text already delivered.
    if (streaming && replacements.some(({ literal }) =>
      literal.length > value.length - index && literal.startsWith(value.slice(index)))) break;
    const matched = replacements.find(({ literal }) => value.startsWith(literal, index));
    if (matched) {
      output += matched.replacement;
      index += matched.literal.length;
    } else {
      output += value[index];
      index += 1;
    }
  }
  return { output, pending: value.slice(index) };
}

function configuredModel(candidate: RouteCandidate, config: ProviderConfig): string {
  const model = candidate.model?.trim() || config.defaultModel?.trim() || config.model?.trim();
  if (!model) {
    throw new Error(`Provider ${config.id} has no configured model for role ${candidate.role}.`);
  }
  return model;
}

export class ProviderRouter implements AgentCompletionClient {
  readonly #sessionId: string;
  readonly #sessionBindings: readonly ProviderBinding[];
  readonly #cliOverrides: Partial<Record<ProviderBindingRole, ProviderOverride>>;
  readonly #projectRegistry: ProviderRegistryLike;
  readonly #globalRegistry: ProviderRegistryLike;
  readonly #onDegradedRoute?: ProviderRouterOptions["onDegradedRoute"];
  readonly #healthyProviders = new Set<string>();

  public constructor(options: ProviderRouterOptions) {
    if (!options.sessionId.trim()) throw new Error("ProviderRouter requires a session id.");
    this.#sessionId = options.sessionId;
    this.#sessionBindings = options.sessionBindings ?? [];
    this.#cliOverrides = options.cliOverrides ?? {};
    this.#projectRegistry = options.projectRegistry ?? new ProviderRegistry(options.projectRoot);
    this.#globalRegistry = options.globalRegistry ?? new ProviderRegistry(os.homedir());
    this.#onDegradedRoute = options.onDegradedRoute;
  }

  public get sessionId(): string {
    return this.#sessionId;
  }

  public clearHealthCache(): void {
    this.#healthyProviders.clear();
  }

  public async resolve(
    role: ProviderBindingRole,
    override?: ProviderOverride,
    signal?: AbortSignal,
  ): Promise<ResolvedProviderRoute> {
    const { candidates, failures } = await this.#buildCandidates(role, override);
    const literals = new Set<string>();
    for (const [index, candidate] of candidates.entries()) {
      assertNotAborted(signal);
      try {
        const route = await this.#resolveCandidate(
          candidate,
          index > 0 || candidate.source === "fallback",
          literals,
          signal,
        );
        if (route.degraded) this.#onDegradedRoute?.(route, failures.map((failure) => publicCompletionText(failure, literals)));
        return route;
      } catch (error) {
        if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw abortError();
        failures.push(publicCompletionText(`${candidate.providerId}: ${safeFailure(error, literals)}`, literals));
      }
    }
    throw new Error(publicCompletionText(`No healthy provider route for ${role}. ${failures.join(" | ")}`.trim(), literals));
  }

  public async complete(request: RoutedProviderCompletionRequest): Promise<AgentCompletionResponse> {
    const explicit: ProviderOverride | undefined = request.providerId || request.model ||
      request.fallbackProviderId || request.fallbackModel || request.allowFallback !== undefined
      ? {
          providerId: request.providerId,
          model: request.model,
          fallbackProviderId: request.fallbackProviderId,
          fallbackModel: request.fallbackModel,
          allowFallback: request.allowFallback,
        }
      : undefined;
    const { candidates, failures } = await this.#buildCandidates(request.role, explicit);
    const literals = new Set<string>();

    for (const [index, candidate] of candidates.entries()) {
      assertNotAborted(request.signal);
      try {
        const route = await this.#resolveCandidate(
          candidate,
          index > 0 || candidate.source === "fallback",
          literals,
          request.signal,
        );
        const result = await withAbort(
          route.adapter.complete(route.config, {
            prompt: publicCompletionText(request.prompt, literals),
            model: route.model,
            systemPrompt: request.systemPrompt === undefined ? undefined : publicCompletionText(request.systemPrompt, literals),
            images: request.images,
            signal: request.signal,
            maxOutputTokens: request.maxOutputTokens,
          }),
          request.signal,
        );
        if (!result.output || !result.output.trim()) {
          throw new Error(`Provider ${route.providerId} returned an empty response.`);
        }
        if (route.degraded) this.#onDegradedRoute?.(route, failures.map((failure) => publicCompletionText(failure, literals, request.images)));
        return { output: publicCompletionText(result.output, literals, request.images), usage: completionUsage(result) };
      } catch (error) {
        if (request.signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw abortError();
        failures.push(publicCompletionText(`${candidate.providerId}: ${safeFailure(error, literals, request.images)}`, literals));
      }
    }

    throw new Error(publicCompletionText(`All configured provider routes failed for ${request.role}. ${failures.join(" | ")}`.trim(), literals));
  }

  public async streamComplete(
    request: RoutedProviderCompletionRequest,
    onChunk: (chunk: string) => void,
  ): Promise<AgentCompletionResponse> {
    const explicit: ProviderOverride | undefined = request.providerId || request.model ||
      request.fallbackProviderId || request.fallbackModel || request.allowFallback !== undefined
      ? {
          providerId: request.providerId,
          model: request.model,
          fallbackProviderId: request.fallbackProviderId,
          fallbackModel: request.fallbackModel,
          allowFallback: request.allowFallback,
        }
      : undefined;
    const { candidates, failures } = await this.#buildCandidates(request.role, explicit);
    const literals = new Set<string>();

    // Once chunks have been surfaced to the consumer, switching candidates
    // would duplicate output, so any later failure is final.
    let delivered = false;
    for (const [index, candidate] of candidates.entries()) {
      assertNotAborted(request.signal);
      let pendingText = "";
      let publicText = "";
      let acceptingChunks = false;
      const handleChunk = (chunk: string): void => {
        if (!acceptingChunks || request.signal?.aborted) return;
        // Only a possible literal prefix survives the callback; ordinary text
        // is processed once, and image/credential echoes stay request-local.
        const next = privateTextParts(pendingText + chunk, literals, request.images ?? [], true);
        pendingText = next.pending;
        publicText += next.output;
        if (next.output) { delivered = true; onChunk(next.output); }
      };
      try {
        const route = await this.#resolveCandidate(
          candidate,
          index > 0 || candidate.source === "fallback",
          literals,
          request.signal,
        );
        const input = {
          prompt: publicCompletionText(request.prompt, literals),
          model: route.model,
          systemPrompt: request.systemPrompt === undefined ? undefined : publicCompletionText(request.systemPrompt, literals),
          images: request.images,
          signal: request.signal,
          maxOutputTokens: request.maxOutputTokens,
        };
        let result: ProviderCompletionResult;
        if (typeof route.adapter.streamComplete === "function") {
          try {
            acceptingChunks = true;
            result = await withAbort(
              route.adapter.streamComplete(route.config, input, handleChunk),
              request.signal,
            );
          } catch (error) {
            if (request.signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw abortError();
            if (delivered) throw error;
            acceptingChunks = false;
            failures.push(publicCompletionText(`${candidate.providerId}: stream: ${safeFailure(error, literals, request.images)}`, literals));
            // The adapter is reachable but its streaming path failed before any
            // output surfaced — retry the same adapter buffered.
            result = await withAbort(route.adapter.complete(route.config, input), request.signal);
          } finally {
            acceptingChunks = false;
          }
        } else {
          result = await withAbort(route.adapter.complete(route.config, input), request.signal);
        }
        if (!result.output || !result.output.trim()) {
          throw new Error(`Provider ${route.providerId} returned an empty response.`);
        }
        if (route.degraded) this.#onDegradedRoute?.(route, failures.map((failure) => publicCompletionText(failure, literals, request.images)));
        // Buffered paths never emitted chunks — emit once for a uniform contract.
        const output = publicCompletionText(result.output, literals, request.images);
        if (!delivered) onChunk(output);
        else if (output.startsWith(publicText) && output.length > publicText.length) onChunk(output.slice(publicText.length));
        return { output, usage: completionUsage(result) };
      } catch (error) {
        if (request.signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw abortError();
        if (delivered) throw new Error(safeFailure(error, literals, request.images));
        failures.push(publicCompletionText(`${candidate.providerId}: ${safeFailure(error, literals, request.images)}`, literals));
      }
    }

    throw new Error(publicCompletionText(`All configured provider routes failed for ${request.role}. ${failures.join(" | ")}`.trim(), literals));
  }

  public async bindingForRole(
    role: ProviderBindingRole,
    override?: ProviderOverride,
    signal?: AbortSignal,
  ): Promise<ProviderBinding> {
    const route = await this.resolve(role, override, signal);
    return {
      role,
      providerId: route.providerId,
      model: route.model,
      degraded: route.degraded,
    };
  }

  async #buildCandidates(
    role: ProviderBindingRole,
    directOverride?: ProviderOverride,
  ): Promise<{ candidates: RouteCandidate[]; failures: string[] }> {
    const projectRoles = await this.#projectRegistry.getRoles();
    const globalRoles = await this.#globalRegistry.getRoles();
    const configuredOverride = directOverride && Object.entries(directOverride).every(([key, value]) => key === "allowFallback" || value === undefined)
      ? { ...this.#cliOverrides[role], allowFallback: directOverride.allowFallback }
      : directOverride ?? this.#cliOverrides[role];
    const sessionBinding = this.#sessionBindings.find((binding) => binding.role === role);
    const projectAssignment = roleAssignment(projectRoles, role);
    const globalAssignment = roleAssignment(globalRoles, role);

    let primary: RouteCandidate | undefined;
    if (configuredOverride?.providerId) {
      primary = {
        role,
        providerId: configuredOverride.providerId,
        model: configuredOverride.model,
        source: "explicit",
        fallbackProviderId: configuredOverride.fallbackProviderId,
        fallbackModel: configuredOverride.fallbackModel,
      };
    } else if (sessionBinding) {
      primary = candidateFromBinding(sessionBinding, "session");
      if (configuredOverride?.model) primary.model = configuredOverride.model;
    } else if (projectAssignment) {
      primary = candidateFromAssignment(role, projectAssignment, "project");
      if (configuredOverride?.model) primary.model = configuredOverride.model;
    } else if (globalAssignment) {
      primary = candidateFromAssignment(role, globalAssignment, "global");
      if (configuredOverride?.model) primary.model = configuredOverride.model;
    }

    const candidates: RouteCandidate[] = primary ? [primary] : [];
    if (configuredOverride?.allowFallback === false) {
      if (!primary) throw new Error(`No provider binding configured for role ${role}.`);
      return { candidates, failures: [] };
    }
    const addFallback = (providerId?: string, model?: string) => {
      if (!providerId) return;
      if (candidates.some((candidate) => candidate.providerId === providerId && candidate.model === model)) return;
      candidates.push({ role, providerId, model, source: "fallback" });
    };

    addFallback(primary?.fallbackProviderId, primary?.fallbackModel);
    addFallback(
      configuredOverride?.fallbackProviderId,
      configuredOverride?.fallbackModel,
    );
    const sessionFallback = this.#sessionBindings.find((binding) =>
      binding.role === role && binding.fallbackProviderId,
    );
    addFallback(sessionFallback?.fallbackProviderId, sessionFallback?.fallbackModel);
    addFallback(projectRoles.fallback?.provider, projectRoles.fallback?.model);
    addFallback(globalRoles.fallback?.provider, globalRoles.fallback?.model);
    if (candidates.length === 0) {
      throw new Error(`No provider binding configured for role ${role}.`);
    }
    return { candidates, failures: [] };
  }

  async #locateProvider(providerId: string): Promise<LocatedProvider> {
    const projectConfig = await this.#projectRegistry.get(providerId);
    if (projectConfig) {
      return {
        registry: this.#projectRegistry,
        registryScope: "project",
        config: projectConfig,
      };
    }
    const globalConfig = await this.#globalRegistry.get(providerId);
    if (globalConfig) {
      return {
        registry: this.#globalRegistry,
        registryScope: "global",
        config: globalConfig,
      };
    }
    throw new Error(`Provider ${providerId} is not configured in the project or global registry.`);
  }

  async #resolveCandidate(
    candidate: RouteCandidate,
    degraded: boolean,
    literals: Set<string>,
    signal?: AbortSignal,
  ): Promise<ResolvedProviderRoute> {
    const located = await this.#locateProvider(candidate.providerId);
    captureCredentialLiterals(located.config, literals);
    if (!located.config.approved) {
      throw new Error(`Provider ${candidate.providerId} is configured but not approved.`);
    }
    const model = configuredModel(candidate, located.config);
    const healthKey = `${located.registryScope}:${located.config.id}`;
    if (!this.#healthyProviders.has(healthKey)) {
      const health = await withAbort(located.registry.test(located.config.id, signal), signal);
      if (!health.ok) throw new Error(health.redactedError || health.message || "health check failed");
      this.#healthyProviders.add(healthKey);
    }
    const { adapter, config } = await located.registry.getAdapter(located.config.id);
    captureCredentialLiterals(config, literals);
    return {
      role: candidate.role,
      providerId: config.id,
      model,
      source: degraded ? "fallback" : candidate.source,
      registryScope: located.registryScope,
      degraded,
      config,
      adapter,
    };
  }
}

export function asSubagentCompletionClient(router: ProviderRouter): AgentCompletionClient {
  return {
    complete: (request) => router.complete({
      role: request.role,
      providerId: request.providerId,
      model: request.model,
      systemPrompt: request.systemPrompt,
      prompt: request.prompt,
      cwd: request.cwd,
      signal: request.signal,
      images: request.images,
    }),
    streamComplete: (request, onChunk) => router.streamComplete({
      role: request.role,
      providerId: request.providerId,
      model: request.model,
      systemPrompt: request.systemPrompt,
      prompt: request.prompt,
      cwd: request.cwd,
      signal: request.signal,
      images: request.images,
    }, onChunk),
  };
}
