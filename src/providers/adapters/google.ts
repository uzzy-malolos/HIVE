import { ProviderAdapter, ProviderConfig, ProviderHealthResult, ProviderCompletionInput, ProviderCompletionResult, ProviderRequestCredential } from '../types.js';
import { readSseStream } from '../streaming.js';
import { validateProviderImages } from '../images.js';
import { outputTokenLimit } from '../limits.js';

function userParts(input: ProviderCompletionInput) {
  return [
    ...validateProviderImages(input.images).map((image) => ({ inlineData: { mimeType: image.mimeType, data: image.data } })),
    { text: input.prompt },
  ];
}

function selectedKey(config: ProviderConfig, credential?: ProviderRequestCredential): string | undefined {
  if (credential?.secret !== undefined) return credential.secret;
  if (config.apiKeyEnv !== undefined) return process.env[config.apiKeyEnv];
  if (config.tokenEnv !== undefined) return undefined;
  return process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
}

function missingKey(config: ProviderConfig): string {
  return config.tokenEnv && !config.apiKeyEnv ? "Google API-key authentication requires apiKeyEnv; tokenEnv-only authentication is unsupported."
    : `Missing environment variable ${config.apiKeyEnv || "GEMINI_API_KEY"}`;
}

export class GoogleAdapter implements ProviderAdapter {
  kind = "google" as const;

  async healthCheck(config: ProviderConfig, credential?: ProviderRequestCredential): Promise<ProviderHealthResult> {
    if (!selectedKey(config, credential)) {
      return { ok: false, providerId: config.id, message: missingKey(config), redactedError: "Missing key" };
    }
    return { ok: true, providerId: config.id, message: "API key is present in environment." };
  }

  async complete(config: ProviderConfig, input: ProviderCompletionInput, credential?: ProviderRequestCredential): Promise<ProviderCompletionResult> {
    const token = selectedKey(config, credential);
    if (!token) throw new Error(missingKey(config));

    const modelId = input.model || config.defaultModel || "gemini-1.5-pro";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${token}`;

    const body: any = {
      contents: [{ role: "user", parts: userParts(input) }],
      ...(input.maxOutputTokens === undefined ? {} : { generationConfig: { maxOutputTokens: outputTokenLimit(input.maxOutputTokens) } }),
    };

    if (input.systemPrompt) {
      body.systemInstruction = { parts: [{ text: input.systemPrompt }] };
    }

    const res = await fetch(url, {
      method: "POST",
      signal: input.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    const data = await res.json() as any;
    if (!res.ok) throw new Error(data.error?.message || `Google error: ${res.status}`);

    const text = publicText(data.candidates?.[0]?.content?.parts);

    return {
      output: text,
      usage: data.usageMetadata ? {
        promptTokens: data.usageMetadata.promptTokenCount,
        completionTokens: data.usageMetadata.candidatesTokenCount,
        totalTokens: data.usageMetadata.totalTokenCount
      } : undefined
    };
  }

  async streamComplete(config: ProviderConfig, input: ProviderCompletionInput, onChunk: (chunk: string) => void, credential?: ProviderRequestCredential): Promise<ProviderCompletionResult> {
    const token = selectedKey(config, credential);
    if (!token) throw new Error(missingKey(config));

    const modelId = input.model || config.defaultModel || "gemini-1.5-pro";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:streamGenerateContent?alt=sse&key=${token}`;

    const body: any = {
      contents: [{ role: "user", parts: userParts(input) }],
      ...(input.maxOutputTokens === undefined ? {} : { generationConfig: { maxOutputTokens: outputTokenLimit(input.maxOutputTokens) } }),
    };
    if (input.systemPrompt) {
      body.systemInstruction = { parts: [{ text: input.systemPrompt }] };
    }

    const res = await fetch(url, {
      method: "POST",
      signal: input.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const err = await res.json() as any;
      throw new Error(err.error?.message || `Google error: ${res.status}`);
    }
    if (!res.body) throw new Error("Streaming response has no body.");

    let output = "";
    let usage: ProviderCompletionResult["usage"];
    await readSseStream(res.body, (event) => {
      if (!event.data) return;
      let parsed: any;
      try { parsed = JSON.parse(event.data); } catch { return; }
      const parts = parsed.candidates?.[0]?.content?.parts;
      if (Array.isArray(parts)) {
        for (const part of parts) {
          if (part?.thought !== true && typeof part?.text === "string" && part.text) {
            output += part.text;
            onChunk(part.text);
          }
        }
      }
      if (parsed.usageMetadata) {
        usage = {
          promptTokens: parsed.usageMetadata.promptTokenCount,
          completionTokens: parsed.usageMetadata.candidatesTokenCount,
          totalTokens: parsed.usageMetadata.totalTokenCount
        };
      }
    });

    return { output, usage };
  }
}

function publicText(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  return parts.flatMap((part: unknown) => {
    if (typeof part !== "object" || part === null || !("text" in part)) return [];
    if ("thought" in part && part.thought === true) return [];
    return typeof part.text === "string" ? [part.text] : [];
  }).join("");
}
