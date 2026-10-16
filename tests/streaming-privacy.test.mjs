import assert from "node:assert/strict";
import test from "node:test";
import { redactKnownSecrets, redactStreamingText } from "../dist/security/secrets.js";
import { GoogleAdapter } from "../dist/providers/adapters/google.js";

test("every growing recognized credential stays redacted before the full token threshold", () => {
  for (const [prefix, suffix] of [
    ["sk-", "abcdefghijklmnop"], ["github_pat_", "abcdefghijklmnop"],
    ["ghp_", "abcdefghijklmnop"], ["xoxb-", "abcdefghijklmnop"],
    ["AKIA", "1234567890ABCDEF"], ["AIza", "abcdefghijklmnopqrstuvxyz123456789"],
    ["hf_", "abcdefghijklmnopqrstuvxyz"], ["Bearer ", "ab.cdefghijk"],
  ]) {
    for (let length = 0; length <= suffix.length; length += 1) {
      const value = `${prefix}${suffix.slice(0, length)}`;
      assert.equal(redactStreamingText(`Public prose ${value}`), "Public prose [REDACTED]", value);
    }
  }
});

test("quoted credential fields redact ordinary values, whitespace, and escaped quotes without breaking JSON", () => {
  const source = JSON.stringify({
    password: "open sesame", API_KEY: "custom-secret", apiKey: "escaped\"value",
    clientSecret: "some\\value", authorization: "ordinary-auth", message: "public text",
  });
  const redacted = redactKnownSecrets(source);
  assert.deepEqual(JSON.parse(redacted), {
    password: "[REDACTED]", API_KEY: "[REDACTED]", apiKey: "[REDACTED]",
    clientSecret: "[REDACTED]", authorization: "[REDACTED]", message: "public text",
  });
  assert.equal(redactKnownSecrets("PASSWORD='open sesame'"), "PASSWORD='[REDACTED]'");
  assert.equal(redactKnownSecrets("{'token': 'ordinary token'}"), "{'token': '[REDACTED]'}");
  for (const input of ['{"password":"s', 'API_KEY="ab', "{'clientSecret':'partial"]) {
    assert.match(redactStreamingText(input), /["']\[REDACTED\]$/);
  }
  const escaped = '{"password":"open sesame\\\\with\\\"quote"}';
  for (let end = escaped.indexOf("open") + 1; end <= escaped.length; end += 1) {
    assert.equal(redactStreamingText(escaped.slice(0, end)).includes("open"), false);
  }
  assert.deepEqual(JSON.parse(redactKnownSecrets('{"api-key":"ordinary","access-token":"private","credentials":{"user":"u","value":"hidden"},"usage":{"totalTokens":3}}')), {
    "api-key": "[REDACTED]", "access-token": "[REDACTED]", credentials: "[REDACTED]", usage: { totalTokens: 3 },
  });
  for (const source of ['password: {"value":"ordinary-secret"}', 'API_KEY=["ordinary-secret"]']) {
    assert.equal(redactKnownSecrets(source).includes("ordinary-secret"), false);
  }
  const alreadyRedacted = "API_KEY=[REDACTED] Bearer [REDACTED]";
  assert.equal(redactKnownSecrets(alreadyRedacted), alreadyRedacted);
  assert.equal(redactKnownSecrets("API_KEY=abc Bearer token123"), alreadyRedacted);
});

const config = { id: "google-test", kind: "google", approved: true, defaultModel: "test-model" };
const credential = { secret: "fixture-request-credential" };

test("Google consumes a successful SSE body once and forwards only public text with usage", async () => {
  const originalFetch = globalThis.fetch;
  const chunks = [];
  try {
    globalThis.fetch = async () => new Response([
      { candidates: [{ content: { parts: [{ thought: true, text: "private thought" }, { text: "Public " }] } }] },
      { candidates: [{ content: { parts: [{ thoughtSignature: "opaque" }, { text: "answer" }] } }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 } },
    ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
    const result = await new GoogleAdapter().streamComplete(config, { prompt: "fixture" }, (chunk) => chunks.push(chunk), credential);
    assert.deepEqual(chunks, ["Public ", "answer"]);
    assert.equal(result.output, "Public answer");
    assert.deepEqual(result.usage, { promptTokens: 2, completionTokens: 3, totalTokens: 5 });
  } finally { globalThis.fetch = originalFetch; }
});

test("Google buffered completion excludes thought parts and keeps every public text part", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json({ candidates: [{ content: { parts: [
      { thought: true, text: "private thought" }, { text: "Public " }, { text: "answer" },
    ] } }] });
    const result = await new GoogleAdapter().complete(config, { prompt: "fixture" }, credential);
    assert.equal(result.output, "Public answer");
    globalThis.fetch = async () => Response.json({ error: { message: "Fixture denied" } }, { status: 403 });
    await assert.rejects(new GoogleAdapter().streamComplete(config, { prompt: "fixture" }, () => {}, credential), /Fixture denied/);
  } finally { globalThis.fetch = originalFetch; }
});
