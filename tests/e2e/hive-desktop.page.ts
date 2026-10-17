import { expect, type Locator, type Page } from "@playwright/test";

export type InspectorTabName = "Changes" | "Files" | "Terminal" | "Evidence" | "Run";

export class HiveDesktopPage {
  constructor(readonly page: Page) {}

  get sidebar(): Locator { return this.page.getByRole("navigation", { name: "Global Navigation" }); }
  get inspector(): Locator { return this.page.getByRole("complementary", { name: "Harness Inspector" }); }

  async expectCockpit(): Promise<void> {
    await expect(this.page).toHaveTitle("HIVE Desktop");
    await expect(this.sidebar).toBeVisible();
    await expect(this.page.getByRole("main").first()).toBeVisible();
  }

  async openRepository(repositoryRoot: string): Promise<void> {
    await this.sidebar.getByLabel("Repository path").fill(repositoryRoot);
    await this.sidebar.getByRole("button", { name: "Open", exact: true }).click();
    await this.expectCurrentProject(repositoryRoot);
    await this.openHiveCode();
  }

  async openRecent(repositoryRoot: string): Promise<void> {
    await this.sidebar.getByRole("button", { name: `Open project ${folderName(repositoryRoot)} (${repositoryRoot})` }).click();
    await this.expectCurrentProject(repositoryRoot);
    await this.openHiveCode();
  }

  async openHiveCode(): Promise<void> {
    await this.sidebar.getByRole("button", { name: "Codex" }).click();
    await expect(this.page.getByLabel("Hive Code Surface")).toBeVisible();
    await expect(this.page.getByLabel("Message HIVE")).toBeVisible();
  }

  async configureOpenAi(secret: string): Promise<void> {
    await this.configureProvider("OpenAI");
    await this.providerDialog.getByLabel("API key").fill(secret);
    await this.providerDialog.getByRole("button", { name: "Store encrypted credential" }).click();
    await expect(this.providerDialog).toHaveCount(0);
    await expect(this.page.getByText("Credential encrypted and stored.")).toBeVisible();
  }

  async approveOllama(): Promise<void> {
    await this.configureProvider("Ollama (local)");
    await this.providerDialog.getByRole("button", { name: "Approve local provider" }).click();
    await expect(this.providerDialog).toHaveCount(0);
    await this.expectProviderConnected("Ollama (local)");
  }

  /** Sends a Hive Code message; with no task selected the first message creates one. */
  async send(message: string): Promise<void> {
    await this.page.getByLabel("Message HIVE").fill(message);
    await this.page.getByRole("button", { name: "Send task" }).click();
    await expect(this.page.getByLabel("Message HIVE")).toHaveValue("");
  }

  async selectTask(title: string): Promise<void> {
    await this.sidebar.getByRole("button", { name: title, exact: true }).click();
    await expect(this.page.getByLabel("Hive Code Surface").locator(".hive-mission-title")).toHaveText(title);
  }

  /** Reads the active run's status from the inspector; settled runs also stop the worker. */
  async expectPhase(phase: string): Promise<void> {
    await this.openTab("Run");
    await expect(this.inspector.locator(".hive-evidence-row", { hasText: "Active Run Status" })).toContainText(phase);
    if (["completed", "cancelled", "failed", "paused"].includes(phase)) {
      await expect(this.page.getByRole("banner").getByLabel("Worker stopped")).toBeVisible();
    }
  }

  async runControl(name: "Pause" | "Resume" | "Cancel"): Promise<void> {
    await this.page.getByRole("group", { name: "Run controls" }).getByRole("button", { name }).click();
  }

  async openTab(name: InspectorTabName): Promise<void> {
    // The Changes tab carries a file-count badge, so match its name as a prefix.
    const tab = this.inspector.getByRole("tab", { name: new RegExp(`^${name}`) });
    await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true");
  }

  async previewAndConfirm(action: "commit" | "discard" | "push" | "PR"): Promise<void> {
    await this.inspector.getByRole("group", { name: "Guarded Git actions" }).getByRole("button", { name: `Preview ${action}` }).click();
    const dialog = this.page.getByRole("dialog", { name: `Confirm ${action}` });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: `Confirm ${action}` }).click();
  }

  private get providerDialog(): Locator { return this.page.getByRole("dialog", { name: "Configure provider" }); }

  private async configureProvider(name: string): Promise<void> {
    await this.page.getByRole("banner").getByRole("button", { name: "Open settings" }).click();
    await this.providerRow(name).getByRole("button", { name: "Configure" }).click();
    await expect(this.providerDialog).toBeVisible();
  }

  private async expectProviderConnected(name: string): Promise<void> {
    await this.page.getByRole("banner").getByRole("button", { name: "Open settings" }).click();
    await expect(this.providerRow(name).locator(".provider-settings-meta")).toHaveText(/· connected$/);
    await this.page.keyboard.press("Escape");
    await expect(this.page.locator(".provider-settings-row")).toHaveCount(0);
  }

  private providerRow(name: string): Locator {
    return this.page.locator(".provider-settings-row").filter({ has: this.page.getByText(name, { exact: true }) });
  }

  private async expectCurrentProject(repositoryRoot: string): Promise<void> {
    const projects = this.sidebar.getByRole("group", { name: "Projects" });
    await expect(projects.getByRole("button", { name: `${folderName(repositoryRoot)} (${repositoryRoot})` })).toHaveAttribute("aria-current", "true");
  }
}

function folderName(repositoryRoot: string): string {
  return repositoryRoot.split(/[\\/]/).filter(Boolean).pop() ?? repositoryRoot;
}
