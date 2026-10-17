import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { closeDesktop, launchDesktop as launch } from "./electron-launch";
import { HiveDesktopPage } from "./hive-desktop.page";

const exec = promisify(execFile);

test.describe.serial("HIVE desktop Hive Code flow", () => {
  let root: string;
  let repository: string;
  let userData: string;
  let app: ElectronApplication;
  let page: Page;
  let errors: string[];

  test.beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "hive-desktop-e2e-"));
    repository = path.join(root, "repository");
    userData = path.join(root, "app-data");
    await exec("git", ["init", "--initial-branch=main", repository]);
    await exec("git", ["config", "user.name", "HIVE E2E"], { cwd: repository });
    await exec("git", ["config", "user.email", "hive-e2e@example.invalid"], { cwd: repository });
    await import("node:fs/promises").then(async ({ writeFile }) => {
      await writeFile(path.join(repository, "README.md"), "fixture\n", "utf8");
      await writeFile(path.join(repository, "hive-desktop-fixture.txt"), "baseline\n", "utf8");
    });
    await exec("git", ["add", "README.md", "hive-desktop-fixture.txt"], { cwd: repository });
    await exec("git", ["commit", "-m", "fixture baseline"], { cwd: repository });
    const remote = path.join(root, "origin.git");
    await exec("git", ["init", "--bare", remote]);
    await exec("git", ["remote", "add", "origin", remote], { cwd: repository });
    await exec("git", ["push", "-u", "origin", "main"], { cwd: repository });
    ({ app, page, errors } = await launch(userData));
  });

  test.afterEach(async () => {
    await closeDesktop(app);
    assertNoRendererErrors(errors);
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  test("encrypts provider credentials, runs a verified task, commits exact files, restores after restart, pushes, and refuses an unsafe PR", async () => {
    const hive = new HiveDesktopPage(page);
    await hive.expectCockpit();
    await hive.openRepository(repository);
    const secret = "e2e-secret-must-never-persist-123456";
    const stored = await hive.configureOpenAi(secret);
    // Windows (DPAPI) and macOS (Keychain) encrypt; keyring-less Linux test hosts use Chromium's basic store.
    expect(stored).toBe("stored");
    await hive.expectProviderConnected("OpenAI");
    await hive.approveOllama();

    // No task is selected, so the first message starts one named after it.
    await hive.send("Create the verified fixture change.");
    await expect(hive.sidebar.getByRole("button", { name: "Create the verified fixture change.", exact: true })).toBeVisible();
    await hive.expectRunStatus("completed");
    await hive.openTab("Evidence");
    await expect(hive.inspector.getByLabel("Verification evidence")).toContainText("deterministic fixture");
    await hive.openTab("Changes");
    await expect(page.getByLabel("Read-only unified diff")).toContainText("hive-desktop-fixture.txt");
    await hive.previewAndConfirm("commit");
    await expect(page.getByText(/Committed 1 reviewed file/i).last()).toBeAttached();
    const firstSession = await currentSessionId(repository);
    const changed = (await exec("git", ["show", "--name-only", "--format=", "hive-coder/" + firstSession], { cwd: repository })).stdout.trim().split(/\r?\n/).filter(Boolean);
    expect(changed).toEqual(["hive-desktop-fixture.txt"]);

    await closeDesktop(app);
    expect(await containsText(userData, secret)).toBe(false);
    ({ app, page, errors } = await launch(userData));
    const restored = new HiveDesktopPage(page);
    await restored.expectCockpit();
    await restored.openRecent(repository);
    await restored.selectTask("Create the verified fixture change.");
    await restored.send("Follow up with another verified turn.");
    const followUpSession = await nextSessionId(repository, firstSession);
    await restored.expectRunStatus("completed");

    await restored.previewAndConfirm("push");
    await expect(page.getByText(/Pushed hive-coder\//i).last()).toBeAttached();
    const remoteBranches = (await exec("git", ["ls-remote", "--heads", "origin"], { cwd: repository })).stdout;
    expect(remoteBranches).toContain(`refs/heads/hive-coder/${followUpSession}`);

    // The fixture remote is a local bare repository, so a pull request must be refused, not faked.
    await restored.previewAndConfirm("PR");
    await expect(page.getByRole("alert")).toContainText(/remote|origin|pull request|GitHub/i);
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("cooperatively pauses and resumes, cancels, then discards only the latest HIVE worktree", async () => {
    const hive = new HiveDesktopPage(page);
    await hive.openRepository(repository);
    await hive.send("[hold] wait for cooperative pause");
    await expect(page.getByRole("group", { name: "Run controls" }).getByRole("button", { name: "Pause" })).toBeVisible();
    await hive.runControl("Pause");
    await hive.expectRunStatus("paused");
    await hive.runControl("Resume");
    await hive.expectRunStatus("completed");
    const resumedWorktree = path.join(repository, ".hivemind", "worktrees", await currentSessionId(repository));

    await hive.send("[hold] wait for cancellation");
    await expect(page.getByRole("group", { name: "Run controls" }).getByRole("button", { name: "Cancel" })).toBeVisible();
    await hive.runControl("Cancel");
    await hive.expectRunStatus("cancelled");
    const cancelledSession = await currentSessionId(repository);

    await hive.send("Create a disposable verified change.");
    const sessionId = await nextSessionId(repository, cancelledSession);
    await hive.expectRunStatus("completed");
    const worktree = path.join(repository, ".hivemind", "worktrees", sessionId);
    await stat(worktree);
    await hive.previewAndConfirm("discard");
    await expect(page.getByText(/discard completed|Discarded/i).last()).toBeAttached();
    await expect.poll(() => stat(worktree).then(() => true, () => false)).toBe(false);
    // Only the discarded run's worktree goes; the earlier completed run keeps its own.
    await stat(resumedWorktree);
  });
});

/** Waits until the task records a run newer than `previous`, so status checks never read the last run. */
async function nextSessionId(repository: string, previous: string): Promise<string> {
  let latest = previous;
  await expect.poll(async () => (latest = await currentSessionId(repository).catch(() => previous)), { timeout: 30_000 }).not.toBe(previous);
  return latest;
}

async function currentSessionId(repository: string): Promise<string> {
  const threads = path.join(repository, ".hivemind", "threads");
  const [thread] = await readdir(threads);
  const record = JSON.parse(await readFile(path.join(threads, thread, "thread.json"), "utf8"));
  return record.runs.at(-1).codingSessionId;
}

async function containsText(root: string, needle: string): Promise<boolean> {
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) { if (await containsText(target, needle)) return true; }
    else if (entry.isFile() && (await stat(target)).size <= 2_000_000 && (await readFile(target).catch(() => Buffer.alloc(0))).includes(Buffer.from(needle))) return true;
  }
  return false;
}

function assertNoRendererErrors(errors: string[]): void {
  expect(errors.filter((message) => !message.includes("favicon") && !message.includes("Debugger ending on ws://")), errors.join("\n")).toEqual([]);
}
