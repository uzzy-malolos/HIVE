import assert from "node:assert/strict";
import test from "node:test";
import { TuiApp } from "../dist/tui/app.js";
import { enableRawMode, disableRawMode } from "../dist/tui/terminal-control.js";

function appHarness(t) {
  const app = new TuiApp(process.cwd());
  app.render = () => {};
  t.after(() => {
    clearTimeout(app.escapeTimer);
  });
  const submissions = [];
  app.submitInput = () => submissions.push(app.state.input);
  return {
    app,
    submissions,
    feed(text) {
      app.inputBuffer += text;
      app.processInputBuffer();
    },
    bytes(chunk) { app.onData(Buffer.from(chunk)); },
  };
}

test("raw UTF-8 survives every byte boundary and grapheme editing keeps emoji intact", (t) => {
  const { app, bytes, feed } = appHarness(t);
  const original = "中文 e\u0301 👩🏽‍💻 🇵🇭";
  for (const byte of Buffer.from(original)) bytes([byte]);
  assert.equal(app.state.input, original);
  assert.equal(app.state.cursor, original.length);

  feed("\x7f");
  assert.equal(app.state.input, "中文 e\u0301 👩🏽‍💻 ");
  feed("\x7f\x7f");
  assert.equal(app.state.input, "中文 e\u0301 ");
  feed("\x1b[D\x7f");
  assert.equal(app.state.input, "中文  ");
  assert.equal(app.state.cursor, "中文 ".length);

  feed("👨‍👩‍👧‍👦\x1b[D\x1b[3~");
  assert.equal(app.state.input, "中文  ");
  assert.equal(app.state.input.includes("\ufffd"), false);
});

test("fragmented bracketed paste treats commands, control keys, and CR/LF as text", (t) => {
  const { app, bytes, submissions } = appHarness(t);
  const input = "\x1b[200~/exit\r\n/clear\rnext\nlast\x03\x15\x1b[A\x1b[201~";
  for (const byte of Buffer.from(input)) bytes([byte]);
  assert.equal(app.state.input, "/exit\n/clear\nnext\nlast[A");
  assert.deepEqual(submissions, []);
  assert.equal(app.stopped, false);
  assert.equal(app.state.scrollOffset, 0);
  assert.equal(app.inputBuffer, "");
  bytes("\r");
  assert.deepEqual(submissions, ["/exit\n/clear\nnext\nlast[A"]);
});

test("pasted /exit stays in the composer until the user presses Enter", (t) => {
  const { app, bytes, submissions } = appHarness(t);
  bytes("\x1b[200~/exit\r\n\x1b[201~");
  assert.equal(app.state.input, "/exit\n");
  assert.equal(app.stopped, false);
  assert.deepEqual(submissions, []);
  bytes("\r");
  assert.deepEqual(submissions, ["/exit\n"]);
});

test("fragmented Escape disambiguates CSI, SS3, and Alt+Enter from cancellation", async (t) => {
  const { app, bytes, feed } = appHarness(t);
  const interrupts = [];
  app.applyInterrupt = (key) => interrupts.push(key);
  bytes("hello");
  bytes("\x1b");
  assert.deepEqual(interrupts, []);
  bytes("[");
  bytes("D");
  assert.equal(app.state.cursor, 4);
  bytes("\x1b");
  bytes("O");
  bytes("D");
  assert.equal(app.state.cursor, 3);
  bytes("\x1b");
  bytes("\r");
  assert.equal(app.state.input, "hel\nlo");
  assert.deepEqual(interrupts, []);

  bytes("\x1b");
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.deepEqual(interrupts, ["escape"]);
  feed("\x1b");
  assert.deepEqual(interrupts, ["escape", "escape"]);
});

test("SS3 arrows and home/end navigate without leaking escape bytes", (t) => {
  const { app, bytes } = appHarness(t);
  bytes("abc");
  bytes("\x1bOH\x1bOC");
  assert.equal(app.state.cursor, 1);
  bytes("\x1bOF\x1bOD");
  assert.equal(app.state.cursor, 2);
  app.state = { ...app.state, history: ["remembered"], input: "", cursor: 0 };
  bytes("\x1bOA");
  assert.equal(app.state.input, "remembered");
  bytes("\x1bOB");
  assert.equal(app.state.input, "");
});

test("readline controls and Alt word motion edit drafts without submitting", (t) => {
  const { app, feed, submissions } = appHarness(t);
  feed("one 中文 👩🏽‍💻");
  feed("\x1bb");
  assert.equal(app.state.cursor, "one 中文 ".length);
  feed("\x1bf");
  assert.equal(app.state.cursor, app.state.input.length);
  feed("\x17");
  assert.equal(app.state.input, "one 中文 ");
  feed("\x1b\x7f");
  assert.equal(app.state.input, "one ");
  feed("second\nlast line\x01");
  assert.equal(app.state.cursor, "one second\n".length);
  feed("\x06\x06\x02\x0b");
  assert.equal(app.state.input, "one second\nl");
  feed("\x05\x01\x0b");
  assert.equal(app.state.input, "one second\n");
  assert.deepEqual(submissions, []);
});

test("Ctrl+Left/Right navigate words in drafts and keep tool card focus when empty", (t) => {
  const { app, feed } = appHarness(t);
  const cards = [];
  app.moveToolCard = (delta) => cards.push(delta);
  feed("alpha beta");
  feed("\x1b[1;5D");
  assert.equal(app.state.cursor, 6);
  feed("\x1b[1;5C");
  assert.equal(app.state.cursor, 10);
  assert.deepEqual(cards, []);
  app.state = { ...app.state, input: "", cursor: 0 };
  feed("\x1b[1;5D\x1b[1;5C");
  assert.deepEqual(cards, [-1, 1]);
});

test("history preserves the unsent draft and cursor; edits to recalls start fresh", (t) => {
  const { app, feed } = appHarness(t);
  app.state = { ...app.state, history: ["newest", "older"] };
  feed("draft ✨\x1b[D");
  const cursor = app.state.cursor;
  feed("\x1b[A\x1b[A");
  assert.equal(app.state.input, "older");
  feed("\x1b[B\x1b[B");
  assert.equal(app.state.input, "draft ✨");
  assert.equal(app.state.cursor, cursor);
  feed("\x1b[A!");
  assert.equal(app.state.input, "newest!");
  assert.equal(app.state.historyIndex, -1);
  feed("\x1b[A\x1b[B");
  assert.equal(app.state.input, "newest!");
});

test("Down without browsing history leaves an unsent draft intact", (t) => {
  const { app, feed } = appHarness(t);
  app.state.history = ["previous"];
  feed("unsent draft\x1b[B");
  assert.equal(app.state.input, "unsent draft");
  assert.equal(app.state.historyIndex, -1);
});

test("invalid partial CSI and SS3 prefixes cannot swallow Ctrl+C", (t) => {
  const { app, bytes } = appHarness(t);
  const interrupts = [];
  app.applyInterrupt = (key) => interrupts.push(key);
  for (const prefix of ["\x1b[", "\x1bO", "\x1b[<12;"]) {
    bytes(prefix);
    bytes("\x03");
    assert.equal(app.inputBuffer, "");
  }
  assert.deepEqual(interrupts, ["ctrl-c", "ctrl-c", "ctrl-c"]);
});

test("Tab accepts a command picker entry without submitting or accepting during paste", (t) => {
  const { app, feed, submissions } = appHarness(t);
  feed("/he");
  assert.equal(app.state.picker.kind, "command");
  feed("\t");
  assert.equal(app.state.input.trim(), "/help");
  assert.equal(app.state.picker, undefined);
  assert.deepEqual(submissions, []);
  app.state = { ...app.state, input: "", cursor: 0 };
  feed("\x1b[200~/he\t\r\x1b[201~");
  assert.equal(app.state.input, "/he\t\n");
  assert.deepEqual(submissions, []);
});

test("multiline arrows keep grapheme columns", (t) => {
  const { app, feed } = appHarness(t);
  feed("a👩🏽‍💻z\n中文x");
  feed("\x1b[D\x1b[A");
  assert.equal(app.state.cursor, "a👩🏽‍💻".length);
  feed("\x1b[B");
  assert.equal(app.state.cursor, "a👩🏽‍💻z\n中文".length);
});

test("raw mode setup and cleanup enable then disable bracketed paste", () => {
  const writes = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => { writes.push(chunk); return true; };
  try {
    enableRawMode();
    disableRawMode();
  } finally {
    process.stdout.write = originalWrite;
  }
  assert.ok(writes.includes("\x1b[?2004h"));
  assert.ok(writes.includes("\x1b[?2004l"));
});
