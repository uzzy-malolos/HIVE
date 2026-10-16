// @ts-nocheck — reads stylesheets from disk; renderer tsconfig has no Node types.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function readFirst(candidates: string[]): string {
  const file = candidates.find((candidate) => existsSync(candidate));
  if (!file) throw new Error("stylesheet not found: " + candidates.join(", "));
  return readFileSync(file, "utf8");
}

const motion = readFirst([
  path.join(process.cwd(), "desktop/renderer/src/styles/motion.css"),
  path.join(process.cwd(), "renderer/src/styles/motion.css"),
  path.join(process.cwd(), "src/styles/motion.css"),
]);

const web = readFirst([
  path.join(process.cwd(), "web/src/styles.css"),
  path.join(process.cwd(), "../web/src/styles.css"),
  path.join(process.cwd(), "../../web/src/styles.css"),
]);

describe("interaction motion contract", () => {
  it("uses a short press offset and keeps reduced motion free of transforms", () => {
    expect(motion).toContain("translate(1px, 1px)");
    expect(motion).toContain("prefers-reduced-motion: reduce");
    expect(motion).toContain("transform: none !important");
    expect(motion).toContain("transition: none !important");
    expect(motion).not.toMatch(/scanline|honeycomb|crt/i);
    expect(web).toContain("translate(1px, 1px)");
    expect(web).toContain("prefers-reduced-motion: reduce");
    expect(web).toContain("transform: none !important");
    expect(web).not.toMatch(/scanline|honeycomb|crt/i);
  });
});
