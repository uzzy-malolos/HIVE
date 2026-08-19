// @ts-nocheck — reads styles.css from disk; renderer tsconfig has no Node types.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function loadStyles(): string {
  const candidates = [
    path.join(process.cwd(), "desktop/renderer/src/styles.css"),
    path.join(process.cwd(), "renderer/src/styles.css"),
    path.join(process.cwd(), "src/styles.css"),
  ];
  const file = candidates.find((candidate) => existsSync(candidate));
  if (!file) throw new Error("styles.css not found from test cwd: " + process.cwd());
  return readFileSync(file, "utf8");
}

const css = loadStyles();

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("modular stylesheet architecture", () => {
  it("imports all canonical desktop modular stylesheets", () => {
    const modularImports = [
      'tokens.css',
      'base.css',
      'shell.css',
      'navigation.css',
      'chat.css',
      'composer.css',
      'code.css',
      'inspector.css',
      'settings.css',
      'usage.css',
      'split.css',
    ];

    for (const file of modularImports) {
      expect(css).toContain(`@import "./styles/${file}";`);
    }
  });
});
