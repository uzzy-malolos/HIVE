import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { KernelTool, ToolExecutionContext } from "../kernel/types.js";

const execAsync = promisify(exec);
const MAX_OUTPUT_CHARS = 20_000;
const TIMEOUT_MS = 30_000;

export const bashTool: KernelTool = {
  definition: {
    name: "bash",
    description: "Execute a command in the workspace directory with timeout and bounded output.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command line string to run" },
      },
      required: ["command"],
    },
    readOnly: false,
  },
  async execute(args: Record<string, unknown>, context: ToolExecutionContext): Promise<string> {
    if (!context.workspaceRoot) throw new Error("A workspace must be open to execute commands.");
    const command = String(args.command);

    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: context.workspaceRoot,
        timeout: TIMEOUT_MS,
        maxBuffer: 1024 * 1024 * 5, // 5MB buffer
      });

      let output = (stdout || "") + (stderr ? `\n[STDERR]\n${stderr}` : "");
      if (output.length > MAX_OUTPUT_CHARS) {
        output = output.slice(0, MAX_OUTPUT_CHARS) + `\n... [Output truncated at ${MAX_OUTPUT_CHARS} characters]`;
      }

      return output || "(command executed with no output)";
    } catch (err: unknown) {
      const execError = err as { stdout?: string; stderr?: string; message?: string; code?: number };
      const output = (execError.stdout || "") + (execError.stderr ? `\n[STDERR]\n${execError.stderr}` : "");
      return `Command failed (exit code ${execError.code ?? 1}):\n${output || execError.message || String(err)}`;
    }
  },
};
