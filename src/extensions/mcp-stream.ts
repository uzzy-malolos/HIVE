import { cancelled, MAX_MESSAGE_BYTES } from "./io.js";

/** One bounded SSE event, rather than an unbounded lifetime-sized response. */
export interface McpSseEvent { data: string; id?: string; retry?: number }

export async function* mcpSseEvents(body: ReadableStream<Uint8Array>, signal: AbortSignal, options: { resumable?: boolean } = {}): AsyncGenerator<McpSseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  const decode = (bytes?: Uint8Array, stream = false) => { try { return decoder.decode(bytes, { stream }); } catch { throw new Error("Invalid MCP SSE UTF-8 data"); } };
  let line = ""; let data: string[] = []; let bytes = 0; let id: string | undefined; let retry: number | undefined; let cr = false;
  const acceptLine = (): McpSseEvent | undefined => {
    const value = line; line = "";
    if (!value) {
      const event = data.length || id !== undefined || retry !== undefined ? { data: data.join("\n"), ...(id === undefined ? {} : { id }), ...(retry === undefined ? {} : { retry }) } : undefined;
      data = []; bytes = 0; id = undefined; retry = undefined; return event;
    }
    if (value.startsWith(":")) return;
    const colon = value.indexOf(":"); const field = colon < 0 ? value : value.slice(0, colon);
    let content = colon < 0 ? "" : value.slice(colon + 1); if (content.startsWith(" ")) content = content.slice(1);
    if (field === "data") { if (data.length >= 8192) throw new Error("MCP SSE event exceeded data line limit"); data.push(content); }
    else if (field === "id" && options.resumable !== false) {
      // IDs are reflected in an HTTP header on reconnect, so reject controls.
      if (content.length > 1024 || /[^\x20-\x7e]/u.test(content)) throw new Error("Invalid MCP SSE event identifier");
      id = content;
    } else if (field === "retry" && options.resumable !== false && /^\d{1,10}$/u.test(content)) {
      const milliseconds = Number(content);
      if (milliseconds > 120_000) throw new Error("MCP SSE retry exceeds 120000ms; reconnect explicitly");
      retry = milliseconds;
    }
    return;
  };
  try {
    while (true) {
      if (signal.aborted) throw cancelled();
      const part = await reader.read();
      if (part.done) break;
      const text = decode(part.value, true);
      for (const character of text) {
        if (cr) { cr = false; if (character === "\n") continue; }
        if (character === "\r" || character === "\n") {
          if (line) { bytes += 1; if (bytes > MAX_MESSAGE_BYTES) throw new Error("MCP SSE event exceeded message size limit"); }
          const event = acceptLine(); if (event) yield event;
          cr = character === "\r";
        } else {
          bytes += Buffer.byteLength(character);
          if (bytes > MAX_MESSAGE_BYTES) throw new Error("MCP SSE event exceeded message size limit");
          line += character;
        }
      }
    }
    if (signal.aborted) throw cancelled();
    decode();
    // An unterminated event is incomplete and must not be dispatched.
  } finally { signal.removeEventListener("abort", abort); await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

export async function mcpJsonBody(body: ReadableStream<Uint8Array>): Promise<unknown> {
  const reader = body.getReader(); const parts: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_MESSAGE_BYTES) throw new Error("MCP response exceeded message size limit");
      parts.push(part.value);
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts)));
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

export function mcpReconnectDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(cancelled());
  return new Promise((resolve, reject) => {
    const finish = () => { signal.removeEventListener("abort", abort); resolve(); };
    const timer = setTimeout(finish, milliseconds);
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(cancelled()); };
    signal.addEventListener("abort", abort, { once: true });
  });
}
