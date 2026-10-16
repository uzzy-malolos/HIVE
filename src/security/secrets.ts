const KNOWN_SECRET_RULES: Array<{ pattern: RegExp; replacement: string | ((match: string, key: string) => string) }> = [
  { pattern: /\bsk-[A-Za-z0-9_-]{12,}\b/g, replacement: "[REDACTED]" },
  { pattern: /\bgh[pousr]_[A-Za-z0-9_]{12,}\b/g, replacement: "[REDACTED]" },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{12,}\b/g, replacement: "[REDACTED]" },
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{12,}\b/g, replacement: "[REDACTED]" },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: "[REDACTED]" },
  { pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/g, replacement: "[REDACTED]" },
  { pattern: /\bhf_[A-Za-z0-9]{20,}\b/g, replacement: "[REDACTED]" },
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{3,}\b/gi, replacement: "Bearer [REDACTED]" },
  // Check the marker separately so repeated markers cannot repartition a key quadratically.
  { pattern: /\b(?=[A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY|AUTHORIZATION|ACCESS_KEY))([A-Z0-9_]+)\s*[:=]\s*([^\s"'`]+)/gi, replacement: (_match, key) => `${key}=[REDACTED]` },
];

const SENSITIVE_FIELD_NAMES = new Set([
  "secret", "token", "apikey", "password", "privatekey", "authorization", "accesskey", "accesskeyid",
  "secretaccesskey", "accesstoken", "refreshtoken", "clientsecret", "credential", "credentials",
]);

const TRAILING_SECRET = /\b(?:sk-[A-Za-z0-9_-]*|github_pat_[A-Za-z0-9_]*|gh[pousr]_[A-Za-z0-9_]*|xox[baprs]-[A-Za-z0-9-]*|AKIA[0-9A-Z]*|AIza[0-9A-Za-z_-]*|hf_[A-Za-z0-9]*|Bearer\s+\S*)$/i;

/** Quoted, compound, and truncated values need scanning so escaped quotes cannot end redaction early. */
function redactCredentialAssignments(value: string): string {
  // A key starts once per token, avoiding a retry from every character of long public text.
  const assignments = /(["']?)(?<![A-Za-z0-9_-])([A-Za-z0-9_-]+)\1\s*[:=]\s*/g;
  let output = "";
  let copied = 0;
  for (let match = assignments.exec(value); match; match = assignments.exec(value)) {
    const key = match[2].replace(/[^A-Za-z0-9]/g, "").toLowerCase();
    if (!SENSITIVE_FIELD_NAMES.has(key) && !/(?:password|secret|apikey|privatekey|accesskey|accesstoken|refreshtoken|authorization|credential|credentials)$/.test(key)) continue;
    const start = assignments.lastIndex;
    if (start >= value.length) continue;
    if (value.startsWith("[REDACTED]", start)) {
      assignments.lastIndex = start + "[REDACTED]".length;
      continue;
    }
    const quote = value[start];
    let end = start;
    let replacement = "[REDACTED]";
    if (quote === "\"" || quote === "'") {
      end = quotedValueEnd(value, start);
      replacement = `${quote}[REDACTED]${value[end - 1] === quote ? quote : ""}`;
    } else if (quote === "{" || quote === "[") {
      let depth = 0;
      for (end = start; end < value.length; end += 1) {
        const ch = value[end];
        if (ch === "\"" || ch === "'") end = quotedValueEnd(value, end) - 1;
        else if (ch === "{" || ch === "[") depth += 1;
        else if (ch === "}" || ch === "]") {
          depth -= 1;
          if (depth === 0) { end += 1; break; }
        }
      }
      replacement = '"[REDACTED]"';
    } else {
      while (end < value.length && !/[\s,;}\]]/.test(value[end])) end += 1;
      if (match[1]) replacement = '"[REDACTED]"';
    }
    if (end === start) continue;
    output += value.slice(copied, start) + replacement;
    copied = end;
    assignments.lastIndex = end;
  }
  return output + value.slice(copied);
}

function quotedValueEnd(value: string, start: number): number {
  const quote = value[start];
  for (let index = start + 1; index < value.length; index += 1) {
    if (value[index] === "\\") index += 1;
    else if (value[index] === quote) return index + 1;
  }
  return value.length;
}

export function redactKnownSecrets(value: string): string {
  let redacted = redactCredentialAssignments(value);
  for (const rule of KNOWN_SECRET_RULES) redacted = typeof rule.replacement === "string"
    ? redacted.replace(rule.pattern, rule.replacement)
    : redacted.replace(rule.pattern, rule.replacement);
  return redacted;
}

/** Redact complete secrets and a still-growing secret prefix at the end of a stream. */
export function redactStreamingText(value: string): string {
  return redactKnownSecrets(value).replace(TRAILING_SECRET, "[REDACTED]");
}

export function containsKnownSecret(value: string): boolean { return redactKnownSecrets(value) !== value; }

export function isCredentialFieldName(key: string): boolean {
  return SENSITIVE_FIELD_NAMES.has(key.replace(/[^A-Za-z0-9]/g, "").toLowerCase());
}
