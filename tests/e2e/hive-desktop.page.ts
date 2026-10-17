import { expect, type Locator, type Page } from "@playwright/test";

/** Drives the current desktop UI: sidebar projects, Settings providers, and the Hive Code surface. */
export class HiveDesktopPage {
  constructor(readonly page: Page) {}

  get sidebar(): Locator { return this.page.getByRole("navigation", { name: "Global Navigation" }); }
  get inspector(): Locator { return this.page.getByRole("complementary", { name: "Harness Inspector" }); }

  async expectCockpit(): Promise<void> {
    await expect(this.page).toHaveTitle("HIVE Desktop");
    await expect(this.sidebar).toBeVisible();
    await expect(this.page.getByRole("main").first()).toBeVisible();
  }

  /** Opens a project by typing its path, then switches to Hive Code. */
  async openRepository(repositoryRoot: string): Promise<void> {
    const pathInput = this.sidebar.getByLabel("Repository path");
    if (!(await pathInput.isVisible())) await this.sidebar.getByRole("button", { name: "Open project" }).click();
    await pathInput.fill(repositoryRoot);
    await this.sidebar.getByRole("button", { name: "Open", exact: true }).click();
    await expect(this.sidebar.getByRole("group", { name: "Projects" }).locator("[aria-current='true']")).toHaveAttribute("title", repositoryRoot);
    await this.openHiveCode();
  }

  /** Reopens a recent project from the sidebar after a restart. */
  async openRecent(repositoryRoot: string): Promise<void> {
    await this.sidebar.getByRole("button", { name: new RegExp(`\\(${escapeRegExp(repositoryRoot)}\\)$`) }).click();
    await expect(this.sidebar.getByRole("group", { name: "Projects" }).locator("[aria-current='true']")).toHaveAttribute("title", repositoryRoot);
    await this.openHiveCode();
  }

  async openHiveCode(): Promise<void> {
    await this.sidebar.getByRole("button", { name: "Codex" }).click();
    await expect(this.page.getByLabel("Hive Code Surface")).toBeVisible();
  }

  /**
   * Stores an OpenAI key. Returns "refused" when the OS offers no credential encryption (for
   * example Linux without a keyring), where HIVE must refuse rather than persist plaintext.
   */
  async configureOpenAi(secret: string): Promise<"stored" | "refused"> {
    const providers = await this.openProviderSettings();
    await this.providerRow(providers, "OpenAI").getByRole("button", { name: "Configure" }).click();
    const dialog = this.page.getByRole("dialog", { name: "Configure provider" });
    await dialog.getByLabel("API key").fill(secret);
    await dialog.getByRole("button", { name: "Store encrypted credential" }).click();
    const stored = this.page.getByText("Credential encrypted and stored.");
    const refused = this.page.getByRole("alert").filter({ hasText: "plaintext persistence is refused" });
    await expect(stored.or(refused)).toBeVisible();
    if (await stored.isVisible()) return "stored";
    await refused.getByRole("button", { name: "Dismiss error" }).click();
    return "refused";
  }

  async approveOllama(): Promise<void> {
    const providers = await this.openProviderSettings();
    await this.providerRow(providers, "Ollama (local)").getByRole("button", { name: "Configure" }).click();
    await this.page.getByRole("dialog", { name: "Configure provider" }).getByRole("button", { name: "Approve local provider" }).click();
    await expect(this.page.getByRole("dialog")).toHaveCount(0);
  }

  /** A provider row by its exact display name ("OpenAI" must not match "openai-compatible" metadata). */
  providerRow(providers: Locator, name: string): Locator {
    return providers.getByRole("listitem").filter({ has: this.page.locator("strong").getByText(name, { exact: true }) });
  }

  async openProviderSettings(): Promise<Locator> {
    await this.page.getByRole("button", { name: "Open settings" }).click();
    const settings = this.page.getByRole("dialog").filter({ hasText: "Model providers" });
    await expect(settings).toBeVisible();
    return settings;
  }

  /** Sends a Hive Code message; with no task selected this starts a new task titled by the message. */
  async send(message: string): Promise<void> {
    await this.page.getByLabel("Hive Code Surface").getByLabel("Message HIVE").fill(message);
    await this.page.getByRole("button", { name: "Send task" }).click();
  }

  async selectTask(title: string): Promise<void> {
    await this.sidebar.getByRole("button", { name: title, exact: true }).click();
    await expect(this.page.locator(".hive-mission-title")).toHaveText(title);
  }

  /** Waits for the active run to reach a status, read from the inspector's Run tab. */
  async expectRunStatus(status: string): Promise<void> {
    await this.openTab("Run");
    await expect(this.inspector.locator(".hive-evidence-row").filter({ hasText: "Active Run Status" })).toContainText(status);
  }

  async openTab(name: "Changes" | "Files" | "Terminal" | "Evidence" | "Run"): Promise<void> {
    const tab = this.inspector.getByRole("tab", { name: new RegExp(`^${name}`) });
    await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true");
  }

  async runControl(name: "Pause" | "Resume" | "Cancel"): Promise<void> {
    await this.page.getByRole("group", { name: "Run controls" }).getByRole("button", { name, exact: true }).click();
  }

  async previewAndConfirm(action: "commit" | "discard" | "push" | "PR"): Promise<void> {
    await this.openTab("Changes");
    await this.inspector.getByRole("button", { name: `Preview ${action}` }).click();
    const dialog = this.page.getByRole("dialog", { name: `Confirm ${action}` });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: `Confirm ${action}` }).click();
  }
}

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
