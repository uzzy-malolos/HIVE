import { expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { closeDesktop, launchDesktop } from "./electron-launch";

const exec = promisify(execFile);

/** Real-app coverage for the sidebar: projects, chat rename/archive/restore/delete-with-undo, and the icon rail. */
test.describe.serial("HIVE desktop sidebar", () => {
  let root: string;
  let repository: string;
  let userData: string;
  let app: ElectronApplication | undefined;
  let page: Page;
  let errors: string[];

  test.beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "hive-sidebar-e2e-"));
    repository = path.join(root, "sidebar-fixture");
    userData = path.join(root, "app-data");
    await exec("git", ["init", "--initial-branch=main", repository]);
    await writeFile(path.join(repository, "README.md"), "fixture\n", "utf8");
    ({ app, page, errors } = await launchDesktop(userData));
  });

  test.afterEach(async () => {
    await closeDesktop(app);
    app = undefined;
    expect(errors, errors.join("\n")).toEqual([]);
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  test("chats without a project, then a project's chats: rename, archive, restore, delete, restart", async () => {
    const sidebar = page.getByRole("navigation", { name: "Global Navigation" });
    await expect(sidebar).toBeVisible();
    // A fresh launch has no project; chats still work and are kept in app data.
    await expect(page.getByRole("alert")).toHaveCount(0);
    await sidebar.getByRole("button", { name: "New chat" }).click();
    await rowMenu(sidebar, "New chat").click();
    await page.getByRole("menuitem", { name: "Rename" }).click();
    await sidebar.getByRole("textbox", { name: "Rename New chat" }).fill("Groceries");
    await sidebar.getByRole("textbox", { name: "Rename New chat" }).press("Enter");
    await expect(sidebar.getByRole("button", { name: "Groceries" })).toBeVisible();

    await sidebar.getByLabel("Repository path").fill(repository);
    await sidebar.getByRole("button", { name: "Open", exact: true }).click();
    const projects = sidebar.getByRole("group", { name: "Projects" });
    await expect(projects.getByRole("button", { name: /^sidebar-fixture \(/ })).toHaveAttribute("aria-current", "true");
    await expect(sidebar.getByRole("button", { name: "Groceries" })).toHaveCount(0);

    await sidebar.getByRole("button", { name: "New chat" }).click();
    await expect(sidebar.getByRole("button", { name: "New chat", exact: true }).nth(1)).toBeVisible();
    await rowMenu(sidebar, "New chat").click();
    await page.getByRole("menuitem", { name: "Rename" }).click();
    const rename = sidebar.getByRole("textbox", { name: "Rename New chat" });
    await rename.fill("Release notes");
    await rename.press("Enter");
    await expect(sidebar.getByRole("button", { name: "Release notes" })).toBeVisible();

    await rowMenu(sidebar, "Release notes").click();
    await page.getByRole("menuitem", { name: "Archive" }).click();
    await expect(sidebar.getByRole("button", { name: "Release notes" })).toHaveCount(0);
    await sidebar.getByRole("button", { name: "Account and settings" }).click();
    await page.getByRole("menuitem", { name: "Archived chats" }).click();
    const archived = page.getByRole("dialog", { name: "Archived chats" });
    await archived.getByRole("button", { name: "Restore Release notes" }).click();
    await expect(archived.getByText("No archived chats in this project.")).toBeVisible();
    await archived.getByRole("button", { name: "Close" }).click();
    await expect(sidebar.getByRole("button", { name: "Release notes" })).toBeVisible();

    // The rename and the recent project both persist across a restart.
    await closeDesktop(app);
    ({ app, page, errors } = await launchDesktop(userData));
    const reopened = page.getByRole("navigation", { name: "Global Navigation" });
    await reopened.getByRole("button", { name: /^Open project sidebar-fixture/ }).click();
    await expect(reopened.getByRole("button", { name: "Release notes" })).toBeVisible();

    await deleteChat(page, reopened, "Release notes");
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(reopened.getByRole("button", { name: "Release notes" })).toBeVisible();
    expect(await chatFiles(repository)).toHaveLength(2);

    await deleteChat(page, reopened, "Release notes");
    await expect(reopened.getByRole("button", { name: "Release notes" })).toHaveCount(0);
    await expect.poll(() => chatFiles(repository), { timeout: 15_000 }).toHaveLength(1);

    // Leaving the project brings back the chats that belong to none.
    await reopened.getByRole("button", { name: /^No project/ }).click();
    await expect(reopened.getByRole("button", { name: "Groceries" })).toBeVisible();
    await expect(reopened.getByRole("button", { name: "Release notes" })).toHaveCount(0);
    // Off Windows, git.inspect raises a sticky alert because git is located via where.exe; only
    // failures from leaving the project matter here.
    await expect(page.getByRole("alert").filter({ hasText: /project|repository|chat/i })).toHaveCount(0);
  });

  test("collapses to an icon rail with Ctrl+B and expands from the titlebar", async () => {
    const sidebar = page.getByRole("navigation", { name: "Global Navigation" });
    await expect(sidebar).not.toHaveAttribute("data-collapsed", "true");
    await page.keyboard.press("Control+b");
    await expect(sidebar).toHaveAttribute("data-collapsed", "true");
    await expect(sidebar.getByRole("button", { name: "New chat" })).toBeVisible();
    await page.getByRole("button", { name: "Expand sidebar" }).click();
    await expect(sidebar).not.toHaveAttribute("data-collapsed", "true");
  });
});

function rowMenu(sidebar: Locator, title: string): Locator {
  const row = sidebar.locator(".hive-session-item").filter({ has: sidebar.page().getByRole("button", { name: title, exact: true }) }).first();
  return row.getByRole("button", { name: "Chat options" });
}

async function deleteChat(page: Page, sidebar: Locator, title: string): Promise<void> {
  await sidebar.getByRole("button", { name: title, exact: true }).hover();
  await rowMenu(sidebar, title).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("dialog", { name: "Delete chat?" }).getByRole("button", { name: "Delete" }).click();
}

/** Active chat session files on disk (the deleted chat must actually leave the project). */
async function chatFiles(repository: string): Promise<string[]> {
  const entries = await readdir(path.join(repository, ".hivemind", "chat-sessions")).catch(() => []);
  return entries.filter((name) => /^chat-\d+-[0-9a-f]{4}\.json$/.test(name));
}
