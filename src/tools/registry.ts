import type { KernelTool, SurfaceMode } from "../kernel/types.js";
import { readFileTool, writeFileTool, editFileTool, listDirTool } from "./file-tools.js";
import { grepTool } from "./search-tools.js";
import { bashTool } from "./bash-tool.js";

export class ToolRegistry {
  private static tools: Map<string, KernelTool> = new Map([
    ["read_file", readFileTool],
    ["write_file", writeFileTool],
    ["edit_file", editFileTool],
    ["list_dir", listDirTool],
    ["grep", grepTool],
    ["bash", bashTool],
  ]);

  public static getTool(name: string): KernelTool | undefined {
    return this.tools.get(name);
  }

  public static getToolsForSurface(surface: SurfaceMode): KernelTool[] {
    const all = Array.from(this.tools.values());
    if (surface === "chat") {
      return all.filter((t) => t.definition.readOnly);
    }
    return all;
  }

  public static getToolDefinitionsForSurface(surface: SurfaceMode) {
    return this.getToolsForSurface(surface).map((t) => t.definition);
  }
}
