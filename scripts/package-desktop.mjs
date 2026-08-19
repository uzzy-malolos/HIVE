import { execSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import asar from "@electron/asar";

const rootDir = process.cwd();
const outDir = path.join(rootDir, "dist-binaries");
const unpackedDir = path.join(outDir, "win-unpacked");
const resourcesDir = path.join(unpackedDir, "resources");
const stagingDir = path.join(rootDir, "build", "staging-app");
const electronDist = path.join(rootDir, "node_modules", "electron", "dist");

console.log("==> 1. Assembling staging app...");
if (existsSync(stagingDir)) {
  rmSync(stagingDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
}
mkdirSync(stagingDir, { recursive: true });

if (existsSync(unpackedDir)) {
  try {
    rmSync(unpackedDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  } catch {
    // If folder is busy on Windows, clean directory contents
    try {
      execSync(`powershell -NoProfile -Command "Remove-Item -Path '${unpackedDir}\\*' -Recurse -Force -ErrorAction SilentlyContinue"`);
    } catch {}
  }
}
mkdirSync(unpackedDir, { recursive: true });



// Copy package.json with desktop main entrypoint, dist, and dist-desktop/renderer
const pkg = JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf8"));
pkg.main = "dist/desktop/electron/main.js";
writeFileSync(path.join(stagingDir, "package.json"), JSON.stringify(pkg, null, 2), "utf8");

cpSync(path.join(rootDir, "dist"), path.join(stagingDir, "dist"), { recursive: true });
cpSync(path.join(rootDir, "dist-desktop", "renderer"), path.join(stagingDir, "dist-desktop", "renderer"), { recursive: true });

console.log("==> 2. Populating win-unpacked base from Electron...");
mkdirSync(resourcesDir, { recursive: true });
cpSync(electronDist, unpackedDir, { recursive: true });

// Remove default_app.asar if present
const defaultAppAsar = path.join(resourcesDir, "default_app.asar");
if (existsSync(defaultAppAsar)) {
  rmSync(defaultAppAsar, { force: true });
}

// Rename electron.exe to HIVE.exe
const defaultExe = path.join(unpackedDir, "electron.exe");
const targetExe = path.join(unpackedDir, "HIVE.exe");
if (existsSync(defaultExe)) {
  cpSync(defaultExe, targetExe);
  rmSync(defaultExe, { force: true });
}

console.log("==> 3. Creating app.asar with unpacked worker...");
const appAsarPath = path.join(resourcesDir, "app.asar");
await asar.createPackageWithOptions(stagingDir, appAsarPath, {
  unpack: "**/worker.mjs",
});

await new Promise((resolve) => setTimeout(resolve, 1500));

console.log("==> 4. Packaging NSIS installer & Portable executable with electron-builder...");

execSync("npx electron-builder --win nsis portable --x64 --prepackaged dist-binaries/win-unpacked --publish never", {
  stdio: "inherit",
  cwd: rootDir,
});

console.log("==> 5. Desktop packaging completed successfully!");
