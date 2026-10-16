import { spawn } from "node:child_process";
import { sanitizeTerminalText } from "../security/terminal-text.js";

/** Only invoked by an explicit /copy command; the copied text is never shell code. */
export async function copyToClipboard(text: string): Promise<void> {
  if (Buffer.byteLength(text) > 1024 * 1024) throw new Error("Clipboard text exceeds 1 MiB; use /export instead.");
  const command = process.platform === "win32" ? "powershell.exe" : process.platform === "darwin" ? "pbcopy" : process.env.WAYLAND_DISPLAY ? "wl-copy" : "xclip";
  const args = process.platform === "win32" ? ["-NoProfile", "-NonInteractive", "-STA", "-Command",
    "[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false); Set-Clipboard -Value ([Console]::In.ReadToEnd())"]
    : process.platform === "darwin" || process.env.WAYLAND_DISPLAY ? [] : ["-selection", "clipboard"];
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "USERPROFILE", "HOME", "LANG", "LC_ALL", "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true, env, stdio: ["pipe", "ignore", "pipe"] });
    let detail = "";
    let failure: Error | undefined;
    const timer = setTimeout(() => { failure = new Error("Clipboard operation timed out."); child.kill("SIGKILL"); }, 5000);
    child.stderr.on("data", (chunk: Buffer) => { detail = (detail + chunk.toString("utf8")).slice(0, 2000); });
    child.stdin.on("error", () => { failure ??= new Error("Clipboard tool did not accept the text."); });
    child.once("error", () => { clearTimeout(timer); reject(new Error(`Clipboard tool ${command} is unavailable; use /export instead.`)); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (failure || code !== 0) reject(failure ?? new Error(`Clipboard tool failed: ${sanitizeTerminalText(detail) || `exit ${String(code)}`}`));
      else resolve();
    });
    child.stdin.end(text, "utf8");
  });
}
