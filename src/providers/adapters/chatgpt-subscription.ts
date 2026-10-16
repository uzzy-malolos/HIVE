import { createCodexAppServer, type CodexAppServerOptions } from '../codex-app-server.js';
import { outputTokenLimit } from '../limits.js';
import type { ProviderAdapter, ProviderChunkHandler, ProviderCompletionInput, ProviderCompletionResult, ProviderConfig, ProviderHealthResult, ProviderRequestCredential } from '../types.js';

export class ChatGptSubscriptionAdapter implements ProviderAdapter {
  readonly kind = 'chatgpt-subscription';

  constructor(private readonly options: CodexAppServerOptions = {}) {}

  private validate(config: ProviderConfig, credential?: ProviderRequestCredential): void {
    if (config.authType !== 'oauth' || config.baseUrl || config.apiKeyEnv || config.tokenEnv || credential) {
      throw new Error('ChatGPT subscription uses HIVE-managed Codex sign-in, without API keys, bearer tokens, or custom endpoints.');
    }
  }

  async healthCheck(config: ProviderConfig, credential?: ProviderRequestCredential, signal?: AbortSignal): Promise<ProviderHealthResult> {
    this.validate(config, credential);
    signal?.throwIfAborted();
    const client = await createCodexAppServer({ ...this.options, signal });
    try {
      const status = await client.accountStatus(signal);
      return { ok: status.authenticated && status.authMode === 'chatgpt', providerId: config.id,
        message: status.authenticated ? 'HIVE ChatGPT subscription is signed in. Authenticated generation is verified separately.' : 'Sign in with HIVE providers login before using the ChatGPT subscription.' };
    } finally { await client.close(); }
  }

  complete(config: ProviderConfig, input: ProviderCompletionInput, credential?: ProviderRequestCredential): Promise<ProviderCompletionResult> {
    return this.streamComplete(config, input, () => {}, credential);
  }

  async streamComplete(config: ProviderConfig, input: ProviderCompletionInput, onChunk: ProviderChunkHandler, credential?: ProviderRequestCredential): Promise<ProviderCompletionResult> {
    this.validate(config, credential);
    outputTokenLimit(input.maxOutputTokens);
    if (input.maxOutputTokens !== undefined) throw new Error('ChatGPT subscription via this Codex app-server cannot enforce maxOutputTokens. Choose a provider with request token limits for this operation.');
    input.signal?.throwIfAborted();
    const client = await createCodexAppServer({ ...this.options, signal: input.signal });
    try { return await client.complete(input, onChunk); }
    finally { await client.close(); }
  }
}
