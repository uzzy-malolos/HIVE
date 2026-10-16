import type { McpConnection } from "./types.js";
import { mcpUri, stringArguments } from "./mcp-advanced.js";
import { keys, object, string } from "./io.js";

export type McpContextOperation = "list_resources" | "list_resource_templates" | "read_resource" | "list_prompts" | "get_prompt" | "complete" | "subscribe_resource" | "unsubscribe_resource" | "list_tasks" | "task_status" | "task_result" | "cancel_task" | "continue_task" | "subscribe_task" | "unsubscribe_task";

/** Shared validated operations for explicit commands and approved agent context calls. */
export async function invokeMcpContext(connection: McpConnection, operation: McpContextOperation, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  switch (operation) {
    case "list_resources": keys(args, [], operation); return connection.listResources({ signal });
    case "list_resource_templates": keys(args, [], operation); return connection.listResourceTemplates({ signal });
    case "read_resource": keys(args, ["uri"], operation); return connection.readResource(mcpUri(args.uri), { signal });
    case "subscribe_resource": {
      keys(args, ["uri"], operation); const uri = mcpUri(args.uri);
      await connection.subscribeResource(uri, { signal });
      try { await connection.startBackground({ signal }); }
      catch (error) { await connection.unsubscribeResource(uri, { signal }); throw error; }
      return { subscribed: uri };
    }
    case "unsubscribe_resource": keys(args, ["uri"], operation); await connection.unsubscribeResource(mcpUri(args.uri), { signal }); return { unsubscribed: args.uri };
    case "list_tasks": keys(args, ["cursor"], operation); return connection.listTasks({ signal, ...(args.cursor === undefined ? {} : { cursor: string(args.cursor, "task cursor", 4096) }) });
    case "task_status": keys(args, ["taskId"], operation); return connection.getTask(string(args.taskId, "task id", 1024), { signal });
    case "task_result": keys(args, ["taskId"], operation); return connection.getTaskResult(string(args.taskId, "task id", 1024), { signal });
    case "cancel_task": keys(args, ["taskId"], operation); return connection.cancelTask(string(args.taskId, "task id", 1024), { signal });
    case "continue_task": keys(args, ["taskId"], operation); return connection.updateTask(string(args.taskId, "task id", 1024), { signal });
    case "subscribe_task": {
      keys(args, ["taskId"], operation); const id = string(args.taskId, "task id", 1024);
      await connection.subscribeTask(id, { signal });
      try { await connection.startBackground({ signal }); }
      catch (error) { await connection.unsubscribeTask(id, { signal }); throw error; }
      return { subscribedTask: id };
    }
    case "unsubscribe_task": keys(args, ["taskId"], operation); await connection.unsubscribeTask(string(args.taskId, "task id", 1024), { signal }); return { unsubscribedTask: args.taskId };
    case "list_prompts": keys(args, [], operation); return connection.listPrompts({ signal });
    case "get_prompt": keys(args, ["name", "arguments"], operation); return connection.getPrompt(string(args.name, "prompt name", 128), stringArguments(args.arguments ?? {}, "prompt arguments"), { signal });
    case "complete": {
      keys(args, ["reference", "argument", "arguments"], operation);
      const ref = object(args.reference, "completion reference");
      const reference = ref.type === "ref/prompt" ? { type: "ref/prompt" as const, name: string(ref.name, "prompt name", 128) }
        : ref.type === "ref/resource" ? { type: "ref/resource" as const, uri: mcpUri(ref.uri) } : undefined;
      if (!reference) throw new Error("Completion reference must be ref/prompt or ref/resource");
      keys(ref, reference.type === "ref/prompt" ? ["type", "name"] : ["type", "uri"], "completion reference");
      const argument = object(args.argument, "completion argument"); keys(argument, ["name", "value"], "completion argument");
      if (typeof argument.value !== "string") throw new Error("Completion argument value must be a string");
      return connection.complete(reference, { name: string(argument.name, "argument name", 128), value: argument.value },
        { signal, ...(args.arguments === undefined ? {} : { context: { arguments: stringArguments(args.arguments, "completion context") } }) });
    }
    default: { const unreachable: never = operation; throw new Error(`Unsupported MCP context operation: ${unreachable}`); }
  }
}
