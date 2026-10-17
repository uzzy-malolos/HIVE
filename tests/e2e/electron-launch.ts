import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { createRequire } from "node:module";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..", "..");
const main = path.join(projectRoot, "dist", "desktop", "electron", "main.js");
const fixtureWorker = path.join(import.meta.dirname, "fixture-worker.mjs");
// The electron package's main export is the platform's executable path (electron.exe, electron, Electron.app).
const electronExecutable = createRequire(import.meta.url)("electron") as unknown as string;

/** Launches the built desktop app against the deterministic fixture worker and an isolated user-data directory. */
export async function launchDesktop(userData: string): Promise<{ app: ElectronApplication; page: Page; errors: string[] }> {
  const errors: string[] = [];
  // Chromium refuses to sandbox as root, which is how Linux CI containers usually run.
  const args = process.platform === "linux" && process.getuid?.() === 0 ? ["--no-sandbox", main] : [main];
  const app = await electron.launch({
    executablePath: electronExecutable, args, cwd: projectRoot,
    env: electronEnvironment({ HIVE_DESKTOP_TESTING: "1", HIVE_DESKTOP_TEST_USER_DATA: userData, HIVE_DESKTOP_TEST_WORKER_MODULE: fixtureWorker }),
  });
  app.process().stderr?.on("data", (chunk) => {
    const message = `main stderr: ${String(chunk)}`;
    if (!isPlatformNoise(message)) errors.push(message);
    process.stderr.write(message);
  });
  const page = await Promise.race([
    app.firstWindow(),
    new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error(`Electron window did not open. ${errors.join(" ")}`)), 15_000); timer.unref(); }),
  ]);
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => { if (message.type() === "error") errors.push(`console: ${message.text()}`); });
  await page.waitForLoadState("domcontentloaded");
  return { app, page, errors };
}

export async function closeDesktop(app: ElectronApplication | undefined): Promise<void> {
  if (!app) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    app.close(),
    new Promise<void>((resolve) => { timer = setTimeout(() => { app.process().kill(); resolve(); }, 5_000); }),
  ]).catch(() => app.process().kill());
  if (timer) clearTimeout(timer);
}

function electronEnvironment(testValues: Record<string, string>): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  const windows = ["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP", "LOCALAPPDATA", "APPDATA", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "COMSPEC", "PATHEXT", "ProgramFiles", "ProgramFiles(x86)"];
  const posix = ["HOME", "TMPDIR", "DISPLAY", "XAUTHORITY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR"];
  for (const key of [...windows, ...posix]) {
    if (process.env[key]) environment[key] = process.env[key];
  }
  return { ...environment, ...testValues };
}

/** Chromium logs GPU, D-Bus and certificate chatter on headless Linux that says nothing about HIVE. */
function isPlatformNoise(message: string): boolean {
  return /dbus|gpu|viz_main|libva|Gtk|ssl_client_socket|handshake failed|Fontconfig|Debugger (listening|attached)|For help, see/i.test(message);
}
