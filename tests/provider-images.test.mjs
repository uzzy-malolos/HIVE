import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadProviderImage, validateProviderImages, MAX_PROVIDER_IMAGE_BYTES } from "../dist/providers/images.js";
import { getAdapterForKind } from "../dist/providers/health.js";

// Public, generated one-pixel fixtures contain no workspace or user data.
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64");
const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
const inputImage = { mimeType: "image/png", data: png.toString("base64") };

async function fixtureWorkspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hive-images-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test("selected image loader reads supported bytes without creating persisted attachments", async (t) => {
  const root = await fixtureWorkspace(t);
  await fs.writeFile(path.join(root, "pixel.png"), png);
  await fs.writeFile(path.join(root, "pixel.gif"), gif);
  assert.deepEqual(await loadProviderImage(root, "pixel.png"), inputImage);
  assert.deepEqual(await loadProviderImage(root, path.join(root, "pixel.gif")), { mimeType: "image/gif", data: gif.toString("base64") });
  assert.deepEqual((await fs.readdir(root)).sort(), ["pixel.gif", "pixel.png"]);
});

test("selected image loader rejects traversal, URLs, sensitive paths, unsupported types, and mismatched bytes", async (t) => {
  const root = await fixtureWorkspace(t);
  await fs.writeFile(path.join(root, "pixel.jpg"), png);
  await fs.writeFile(path.join(root, "text.png"), "This is a fixture text file.");
  await fs.writeFile(path.join(root, "picture.svg"), "<svg></svg>");
  await fs.writeFile(path.join(root, ".env.png"), png);
  await fs.mkdir(path.join(root, ".hive"));
  await fs.writeFile(path.join(root, ".hive", "pixel.png"), png);
  for (const imagePath of ["../outside.png", "https://example.invalid/image.png", "data:image/png;base64,fixture", "file:///image.png", "pixel.png:stream"]) {
    await assert.rejects(loadProviderImage(root, imagePath), /workspace|local/i);
  }
  for (const imagePath of [".env.png", ".hive/pixel.png"]) {
    await assert.rejects(loadProviderImage(root, imagePath), /sensitive/i);
  }
  for (const imagePath of ["pixel.jpg", "text.png"]) {
    await assert.rejects(loadProviderImage(root, imagePath), /header/i);
  }
  await assert.rejects(loadProviderImage(root, "picture.svg"), /PNG, JPEG, WebP, or GIF/);
});

test("selected image loader bounds reads and rejects symlinks outside the workspace or into sensitive paths", async (t) => {
  const root = await fixtureWorkspace(t);
  await fs.writeFile(path.join(root, "oversize.png"), "");
  const oversized = await fs.open(path.join(root, "oversize.png"), "r+");
  await oversized.truncate(MAX_PROVIDER_IMAGE_BYTES + 1);
  await oversized.close();
  await assert.rejects(loadProviderImage(root, "oversize.png"), /10 MiB/);
  await fs.mkdir(path.join(root, "directory.png"));
  await assert.rejects(loadProviderImage(root, "directory.png"));
  const outside = await fixtureWorkspace(t);
  await fs.writeFile(path.join(outside, "pixel.png"), png);
  await fs.mkdir(path.join(root, "secrets"));
  await fs.writeFile(path.join(root, "secrets", "pixel.png"), png);
  try {
    await fs.symlink(outside, path.join(root, "outside"), "junction");
    await fs.symlink(path.join(root, "secrets"), path.join(root, "alias"), "junction");
  } catch (error) {
    if (error.code === "EPERM" || error.code === "EACCES") { t.diagnostic("Symlink creation unavailable on this host; lexical, size, and type checks still verified."); return; }
    throw error;
  }
  await assert.rejects(loadProviderImage(root, "outside/pixel.png"), /workspace/);
  await assert.rejects(loadProviderImage(root, "alias/pixel.png"), /sensitive/);
});

test("provider image boundary rejects malformed, unsupported, and oversized image data without echoing it", () => {
  assert.deepEqual(validateProviderImages(undefined), []);
  assert.deepEqual(validateProviderImages([inputImage]), [inputImage]);
  for (const image of [
    { mimeType: "image/png", data: "https://example.invalid/image.png" },
    { mimeType: "image/jpeg", data: inputImage.data },
    { mimeType: "image/svg+xml", data: Buffer.from("fixture-private-value").toString("base64") },
    { data: Buffer.from("fixture-private-value").toString("base64") },
    { mimeType: "image/png", data: "A".repeat(Math.ceil(MAX_PROVIDER_IMAGE_BYTES / 3) * 4 + 4) },
  ]) {
    assert.throws(() => validateProviderImages([image]), (error) => {
      assert.equal(error.message.includes("fixture-private-value"), false);
      assert.equal(error.message.includes(image.data), false);
      return true;
    });
  }
});

const configs = {
  openai: { kind: "openai", id: "fixture-openai", authType: "api-key" },
  "openai-compatible": { kind: "openai-compatible", id: "fixture-compatible", authType: "none", baseUrl: "https://compatible.example.test/v1" },
  openrouter: { kind: "openrouter", id: "fixture-openrouter", authType: "api-key" },
  local: { kind: "local", id: "fixture-local", authType: "none", baseUrl: "http://127.0.0.1:11435/v1" },
  custom: { kind: "custom", id: "fixture-custom", authType: "none", baseUrl: "https://custom.example.test/v1" },
  anthropic: { kind: "anthropic", id: "fixture-anthropic", authType: "api-key" },
  google: { kind: "google", id: "fixture-google", authType: "api-key" },
  ollama: { kind: "ollama", id: "fixture-ollama", authType: "none" },
};
const credential = { secret: "fixture-request-credential", kind: "api-key" };
const completion = { prompt: "Describe this fixture image", systemPrompt: "Use public text only", model: "fixture-vision", images: [inputImage] };

function responseFor(kind, streaming) {
  if (!streaming) {
    if (kind === "anthropic") return Response.json({ content: [{ type: "text", text: "Public answer" }] });
    if (kind === "google") return Response.json({ candidates: [{ content: { parts: [{ thought: true, text: "Private thought" }, { text: "Public answer" }] } }] });
    if (kind === "ollama") return Response.json({ message: { content: "Public answer" } });
    return Response.json({ choices: [{ message: { content: "Public answer" } }] });
  }
  if (kind === "anthropic") return new Response([
    'event: message_start\ndata: {"message":{"usage":{"input_tokens":2}}}\n\n',
    'event: content_block_delta\ndata: {"delta":{"type":"thinking_delta","thinking":"Private thought"}}\n\n',
    'event: content_block_delta\ndata: {"delta":{"type":"text_delta","text":"Public answer"}}\n\n',
    'event: message_delta\ndata: {"usage":{"output_tokens":3}}\n\n',
  ].join(""), { headers: { "Content-Type": "text/event-stream" } });
  if (kind === "google") return new Response(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ thought: true, text: "Private thought" }, { text: "Public answer" }] } }] })}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
  if (kind === "ollama") return new Response('{"message":{"content":"Public answer"},"done":true}\n', { headers: { "Content-Type": "application/x-ndjson" } });
  return new Response('data: {"choices":[{"delta":{"content":"Public answer"}}]}\n\ndata: [DONE]\n\n', { headers: { "Content-Type": "text/event-stream" } });
}

function assertImagePayload(kind, payload, requestUrl, streaming) {
  if (kind === "google") {
    const url = new URL(requestUrl);
    assert.equal(url.origin, "https://generativelanguage.googleapis.com");
    assert.equal(url.pathname, `/v1beta/models/${completion.model}:${streaming ? "streamGenerateContent" : "generateContent"}`);
    assert.equal(url.searchParams.get("alt"), streaming ? "sse" : null);
    assert.deepEqual(payload.contents[0].parts, [{ inlineData: inputImage }, { text: completion.prompt }]);
    assert.deepEqual(payload.systemInstruction, { parts: [{ text: completion.systemPrompt }] });
  } else if (kind === "anthropic") {
    assert.deepEqual(payload.messages[0].content, [
      { type: "image", source: { type: "base64", media_type: inputImage.mimeType, data: inputImage.data } },
      { type: "text", text: completion.prompt },
    ]);
    assert.equal(payload.system, completion.systemPrompt);
  } else if (kind === "ollama") {
    assert.deepEqual(payload.messages[1], { role: "user", content: completion.prompt, images: [inputImage.data] });
  } else {
    assert.deepEqual(payload.messages[1].content, [
      { type: "text", text: completion.prompt },
      { type: "image_url", image_url: { url: `data:image/png;base64,${inputImage.data}` } },
    ]);
  }
  if (kind !== "google") assert.equal(payload.model, completion.model);
  const origins = { openai: "https://api.openai.com", "openai-compatible": "https://compatible.example.test", openrouter: "https://openrouter.ai", local: "http://127.0.0.1:11435", custom: "https://custom.example.test", anthropic: "https://api.anthropic.com", google: "https://generativelanguage.googleapis.com", ollama: "http://localhost:11434" };
  assert.equal(new URL(requestUrl).origin, origins[kind], "credentials and images must reach the configured provider only");
}

for (const [kind, config] of Object.entries(configs)) {
  for (const streaming of [false, true]) {
    test(`${kind} ${streaming ? "streaming" : "buffered"} sends actual image bytes and returns public text`, async (t) => {
      let calls = 0;
      t.mock.method(globalThis, "fetch", async (url, options) => {
        calls += 1;
        assertImagePayload(kind, JSON.parse(options.body), url, streaming);
        return responseFor(kind, streaming);
      });
      const adapter = getAdapterForKind(kind);
      const chunks = [];
      const result = streaming
        ? await adapter.streamComplete(config, completion, (chunk) => chunks.push(chunk), credential)
        : await adapter.complete(config, completion, credential);
      assert.equal(calls, 1);
      assert.equal(result.output, "Public answer");
      if (streaming) assert.deepEqual(chunks, ["Public answer"]);
      if (streaming && kind === "anthropic") assert.deepEqual(result.usage, { promptTokens: 2, completionTokens: 3, totalTokens: 5 });
    });
  }
}

test("unsupported OAuth adapter fails clearly before any fetch", async (t) => {
  t.mock.method(globalThis, "fetch", async () => assert.fail("Unsupported image routes must not issue requests"));
  await assert.rejects(getAdapterForKind("oauth").complete({ id: "fixture-oauth", kind: "oauth" }, completion), /OAuth provider flow is not implemented/);
});

test("custom and local providers without an endpoint cannot send credentials or images to OpenAI", async (t) => {
  t.mock.method(globalThis, "fetch", () => assert.fail("missing custom endpoints must fail before network access"));
  for (const kind of ["openai-compatible", "local", "custom"]) {
    const adapter = getAdapterForKind(kind);
    await assert.rejects(adapter.complete({ id: "missing-endpoint", kind, authType: "api-key" }, completion, credential), /explicit baseUrl/);
    await assert.rejects(adapter.streamComplete({ id: "missing-endpoint", kind, authType: "api-key" }, completion, () => {}, credential), /explicit baseUrl/);
  }
});

test("invalid image bytes never reach an adapter fetch", async (t) => {
  t.mock.method(globalThis, "fetch", async () => assert.fail("Invalid image must be rejected before fetch"));
  for (const [kind, config] of Object.entries(configs)) {
    const invalid = { ...completion, images: [{ mimeType: "image/png", data: "fixture-private-value" }] };
    await assert.rejects(getAdapterForKind(kind).complete(config, invalid, credential), /base64/);
    await assert.rejects(getAdapterForKind(kind).streamComplete(config, invalid, () => {}, credential), /base64/);
  }
});
