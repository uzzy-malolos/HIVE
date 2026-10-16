import { ProviderAdapter, ProviderConfig, ProviderHealthResult, ProviderCompletionInput, ProviderCompletionResult, ProviderRequestCredential } from '../types.js';
import { readLineStream } from '../streaming.js';
import { validateProviderImages } from '../images.js';
import { outputTokenLimit } from '../limits.js';

function userMessage(input: ProviderCompletionInput) {
  const images = validateProviderImages(input.images);
  return { role: "user", content: input.prompt, ...(images.length ? { images: images.map((image) => image.data) } : {}) };
}

export class OllamaAdapter implements ProviderAdapter {
  kind = "ollama" as const;

  async healthCheck(config: ProviderConfig, _credential?: ProviderRequestCredential, signal?: AbortSignal): Promise<ProviderHealthResult> {
    const baseUrl = config.baseUrl || "http://localhost:11434";
    try {
      const res = await fetch(`${baseUrl}/api/tags`, { method: "GET", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000) });
      if (!res.ok) {
        return {
          ok: false,
          providerId: config.id,
          message: `Health check failed: ${res.status}`,
          redactedError: `Status: ${res.status}`
        };
      }
      return { ok: true, providerId: config.id, message: "Health check passed (Ollama is running)." };
    } catch (err: any) {
      signal?.throwIfAborted();
      return { ok: false, providerId: config.id, message: `Ollama not reachable: ${err.message}`, redactedError: err.message };
    }
  }

  async complete(config: ProviderConfig, input: ProviderCompletionInput): Promise<ProviderCompletionResult> {
    const baseUrl = config.baseUrl || "http://localhost:11434";
    const messages = [];
    if (input.systemPrompt) {
      messages.push({ role: "system", content: input.systemPrompt });
    }
    messages.push(userMessage(input));

    const res = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      signal: input.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: input.model || config.defaultModel,
        ...(input.maxOutputTokens === undefined ? {} : { options: { num_predict: outputTokenLimit(input.maxOutputTokens) } }),
        messages,
        stream: false
      })
    });

    const data = await res.json() as any;
    if (!res.ok) throw new Error(data.error || `Ollama error: ${res.status}`);

    return {
      output: data.message?.content || "",
      usage: {
        promptTokens: data.prompt_eval_count || 0,
        completionTokens: data.eval_count || 0,
        totalTokens: (data.prompt_eval_count || 0) + (data.eval_count || 0)
      }
    };
  }

  async streamComplete(config: ProviderConfig, input: ProviderCompletionInput, onChunk: (chunk: string) => void): Promise<ProviderCompletionResult> {
    const baseUrl = config.baseUrl || "http://localhost:11434";
    const messages = [];
    if (input.systemPrompt) {
      messages.push({ role: "system", content: input.systemPrompt });
    }
    messages.push(userMessage(input));

    const res = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      signal: input.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: input.model || config.defaultModel,
        ...(input.maxOutputTokens === undefined ? {} : { options: { num_predict: outputTokenLimit(input.maxOutputTokens) } }),
        messages,
        stream: true
      })
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let message = text;
      try { message = (JSON.parse(text) as any)?.error || text; } catch { /* keep raw text */ }
      throw new Error(message || `Ollama error: ${res.status}`);
    }
    if (!res.body) throw new Error("Streaming response has no body.");

    let output = "";
    let promptTokens = 0;
    let completionTokens = 0;
    await readLineStream(res.body, (line) => {
      let parsed: any;
      try { parsed = JSON.parse(line); } catch { return; }
      const content = parsed.message?.content;
      if (typeof content === "string" && content) {
        output += content;
        onChunk(content);
      }
      if (parsed.done) {
        promptTokens = parsed.prompt_eval_count || 0;
        completionTokens = parsed.eval_count || 0;
      }
    });

    return {
      output,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens
      }
    };
  }
}
