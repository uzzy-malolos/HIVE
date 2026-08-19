import { chromium } from "playwright";
import { createServer } from "vite";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const rendererDir = path.resolve(rootDir, "desktop", "renderer");
const outputDir = "C:\\Users\\uzzie\\.gemini\\antigravity\\brain\\c8a9812c-7ec8-41e3-b50e-194cead5be0e";

if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

async function capture() {
  console.log("Starting Vite dev server for candidate renderer...");
  const server = await createServer({
    root: rendererDir,
    server: { port: 5198, host: "127.0.0.1" },
    configFile: path.resolve(rootDir, "desktop", "vite.config.ts"),
  });

  await server.listen();
  console.log("Vite dev server listening on http://127.0.0.1:5198");

  let browser;
  try {
    browser = await chromium.launch({ channel: "msedge", headless: true });
  } catch {
    try {
      browser = await chromium.launch({ channel: "chrome", headless: true });
    } catch {
      browser = await chromium.launch({ headless: true });
    }
  }

  const tasks1080 = [
    { scenario: "chat-empty", filename: "candidate_chat_empty_1920x1080.png" },
    { scenario: "chat-active", filename: "candidate_chat_active_1920x1080.png" },
    { scenario: "code-run", filename: "candidate_code_run_1920x1080.png" },
    { scenario: "code-changes", filename: "candidate_code_changes_1920x1080.png" },
    { scenario: "code-diff-expanded", filename: "candidate_code_diff_expanded_1920x1080.png" },
    { scenario: "code-evidence", filename: "candidate_code_evidence_1920x1080.png" },
    { scenario: "code-run", filename: "candidate_code_run_details_1920x1080.png" },
    { scenario: "split", filename: "candidate_split_1920x1080.png" },
    { scenario: "settings", filename: "candidate_settings_1920x1080.png" },
    { scenario: "usage", filename: "candidate_usage_1920x1080.png" },
  ];

  const tasks900 = [
    { scenario: "chat-active", filename: "candidate_chat_1440x900.png" },
    { scenario: "code-run", filename: "candidate_code_1440x900.png" },
    { scenario: "code-changes", filename: "candidate_code_changes_1440x900.png" },
    { scenario: "split", filename: "candidate_split_1440x900.png" },
    { scenario: "settings", filename: "candidate_settings_1440x900.png" },
  ];

  try {
    // 1920x1080
    const page1080 = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    for (const t of tasks1080) {
      const url = `http://127.0.0.1:5198/candidate.html?scenario=${t.scenario}`;
      console.log(`Navigating to ${url} (1920x1080)...`);
      await page1080.goto(url, { waitUntil: "networkidle" });
      await page1080.waitForTimeout(600);
      const destPath = path.join(outputDir, t.filename);
      await page1080.screenshot({ path: destPath, fullPage: false });
      console.log(`Saved: ${t.filename}`);
    }
    await page1080.close();

    // 1440x900
    const page900 = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    for (const t of tasks900) {
      const url = `http://127.0.0.1:5198/candidate.html?scenario=${t.scenario}`;
      console.log(`Navigating to ${url} (1440x900)...`);
      await page900.goto(url, { waitUntil: "networkidle" });
      await page900.waitForTimeout(600);
      const destPath = path.join(outputDir, t.filename);
      await page900.screenshot({ path: destPath, fullPage: false });
      console.log(`Saved: ${t.filename}`);
    }
    await page900.close();

  } finally {
    await browser.close();
    await server.close();
    console.log("All 12 candidate screenshots captured.");
  }
}

capture().catch((err) => {
  console.error("Screenshot capture failed:", err);
  process.exit(1);
});
