/**
 * index.ts
 * Public entry point for the HIVE TUI cockpit.
 * Exports startHiveTui() with all safety guards.
 */

import { TuiApp } from "./app.js";
import type { HiveMode } from "../config.js";

export {
  aggregateSubagentCounts,
  avatarVariant,
  formatElapsed,
  renderSubagentAvatar,
  renderSubagentsPanel,
  roleBadge,
  roleLabel,
  statusGlyph,
  statusLabel,
} from "./subagents.js";
export {
  applyRuntimeEvent,
  reduceRuntimeEvent,
  reduceTuiRuntimeEvent,
  withMotionEnabled,
  withSelectedSubagent,
  withSubagentsExpanded,
} from "./state.js";
export {
  cycleSessionMode,
  decidePermission,
  describeMode,
  nextInterrupt,
  playTurn,
  resolveSessionPosture,
  runtimePostureForMode,
} from "./interaction.js";

export async function startHiveTui(cwd: string, options: { initialCommands?: string[]; initialMode?: HiveMode } = {}): Promise<void> {
  // Guard: must be an interactive TTY
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    process.stderr.write(
      "HIVE TUI requires an interactive terminal (TTY not detected).\n"
    );
    return;
  }

  // Guard: CI environments must not enter interactive mode
  if (
    process.env.CI !== undefined &&
    process.env.CI !== "" &&
    process.env.CI !== "false"
  ) {
    process.stderr.write(
      "HIVE TUI is disabled in CI environments.\n"
    );
    return;
  }

  // Guard: --json suppresses TUI
  if (process.argv.includes("--json")) {
    return;
  }

  const app = new TuiApp(cwd, options);
  await app.start();
}
