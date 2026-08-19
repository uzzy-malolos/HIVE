import type { ApprovalPosture, SurfaceMode, ToolDefinition } from "./types.js";

export interface PermissionEvaluation {
  allowed: boolean;
  requiresApproval: boolean;
  reason?: string;
}

export function evaluateToolPermission(
  tool: ToolDefinition,
  surface: SurfaceMode,
  posture: ApprovalPosture
): PermissionEvaluation {
  // Surface Rule: Chat is strictly read-only
  if (surface === "chat") {
    if (!tool.readOnly) {
      return {
        allowed: false,
        requiresApproval: false,
        reason: `Tool '${tool.name}' mutates state and is prohibited on the Chat surface.`,
      };
    }
    return { allowed: true, requiresApproval: false };
  }

  // Codex Surface Rules
  if (tool.readOnly) {
    return { allowed: true, requiresApproval: false };
  }

  // Mutating tool on Codex surface
  switch (posture) {
    case "yolo":
      return { allowed: true, requiresApproval: false };
    case "auto":
      // In Auto mode, file edits and writes execute with shadow checkpoints; bash commands still request approval
      if (tool.name === "bash" || tool.name === "git_push") {
        return { allowed: true, requiresApproval: true, reason: `Shell execution '${tool.name}' requires approval in Auto mode.` };
      }
      return { allowed: true, requiresApproval: false };
    case "ask":
    default:
      return { allowed: true, requiresApproval: true, reason: `Mutating tool '${tool.name}' requires explicit approval in Ask mode.` };
  }
}
