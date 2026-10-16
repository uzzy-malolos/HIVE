import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { redactKnownSecrets, redactStreamingText } from "../dist/security/secrets.js";

test("redaction handles large public catalogs and assignment keys within a hard process deadline", { timeout: 15_000 }, () => {
  const script = `
    import assert from "node:assert/strict";
    import { redactKnownSecrets, redactStreamingText } from ${JSON.stringify(new URL("../dist/security/secrets.js", import.meta.url).href)};
    const catalog = JSON.stringify(Array.from({ length: 40 }, (_, index) => ({ name: "tool_" + index, description: "x".repeat(16_384) })));
    const repeatedMarker = "TOKEN_".repeat(32_768);
    const whitespace = " ".repeat(131_072);
    for (const source of [catalog, repeatedMarker, "public" + whitespace + "value", "public" + whitespace + ": kept"]) {
      assert.equal(redactKnownSecrets(source), source);
      assert.equal(redactStreamingText(source), source);
    }
    const key = "x".repeat(131_072) + "_CLIENT_SECRET";
    assert.equal(redactKnownSecrets(key + "=opaque-sensitive-value"), key + "=[REDACTED]");
    assert.equal(redactKnownSecrets("PASSWORD" + whitespace + "= opaque-sensitive-value"), "PASSWORD=[REDACTED]");
    process.stdout.write("bounded redaction passed");
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    timeout: 5_000,
    maxBuffer: 64 * 1024,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, "bounded redaction passed");
});

test("assignment boundaries preserve opaque quoted, compound, partial, and suffix credential protection", () => {
  const cases = [
    ["prefix.password='open sesame' suffix", "prefix.password='[REDACTED]' suffix"],
    ['{"custom-client-secret":"ordinary-value","message":"kept"}', '{"custom-client-secret":"[REDACTED]","message":"kept"}'],
    ['payload"password":"ordinary-value" kept', 'payload"password":"[REDACTED]" kept'],
    ['credentials={"nested":["ordinary-value",{"password":"escaped\\\"value"}]} kept', 'credentials="[REDACTED]" kept'],
    ['access-token=["ordinary-value",{"nested":"private"}] kept', 'access-token="[REDACTED]" kept'],
    ['{"private_key":"unterminated\\\"value', '{"private_key":"[REDACTED]'],
    ["SCOPED_TOKEN_BACKUP=ordinary-value kept", "SCOPED_TOKEN_BACKUP=[REDACTED] kept"],
    ["message=SCOPED_TOKEN_BACKUP=ordinary-value kept", "message=SCOPED_TOKEN_BACKUP=[REDACTED] kept"],
    ["x-SCOPED_TOKEN_BACKUP:ordinary-value kept", "x-SCOPED_TOKEN_BACKUP=[REDACTED] kept"],
    ["public-field=ordinary-value kept", "public-field=ordinary-value kept"],
    ['{"public_field":"ordinary-value","tokenCount":3}', '{"public_field":"ordinary-value","tokenCount":3}'],
  ];
  for (const [source, expected] of cases) {
    assert.equal(redactKnownSecrets(source), expected);
    assert.equal(redactStreamingText(source), expected);
  }
});
