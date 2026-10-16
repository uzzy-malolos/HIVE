import path from "node:path";
import { bundlePath, type TreeFile } from "./marketplace-io.js";
import { componentPaths as paths, markdownContent, pluginMarkdown } from "./marketplace-markdown.js";
import { identifier, keys, object, string, validateEnvironmentLiteral } from "./io.js";
import { importClaudeHooks } from "./claude-hooks.js";
import { convertClaudeAgentLspComponents, parsePluginDependencies } from "./plugin-components.js";
import { parsePluginOutputStyle } from "./plugin-output-styles.js";

function json(file: TreeFile): Record<string, unknown> { return object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(file.bytes)), file.name); }
const has = (value: unknown) => value !== undefined && value !== null && (!Array.isArray(value) || value.length > 0) && (typeof value !== "object" || Object.keys(value).length > 0);

/** Convert the supported Claude bundle surface into HIVE's inert, inspectable manifest. */
export function compatibleManifest(files: TreeFile[], name: string, destination: string, entry: Record<string, unknown>): { files: TreeFile[]; warnings: string[] } {
  identifier(name, "installed plugin name");
  const existing = files.find((file) => file.name === "hive.plugin.json");
  if (existing) {
    const manifest = json(existing); keys(manifest, ["version", "name", "description", "mcpServers", "skills", "hooks", "agents", "lspServers", "outputStyles", "dependencies", "pluginVersion"], "HIVE plugin manifest");
    if (manifest.version !== 1) throw new Error("HIVE plugin manifest version must be 1");
    parsePluginDependencies(manifest.dependencies);
    if (manifest.pluginVersion !== undefined) string(manifest.pluginVersion, "pluginVersion", 256);
    return { files: files.map((file) => file === existing ? { ...file, bytes: Buffer.from(JSON.stringify({ ...manifest, name }, null, 2)) } : file), warnings: [] };
  }
  const claude = files.find((file) => file.name === ".claude-plugin/plugin.json");
  const manifest = claude ? json(claude) : entry;
  if (entry.strict !== undefined && typeof entry.strict !== "boolean") throw new Error("Marketplace strict must be a boolean");
  const components = ["commands", "skills", "hooks", "agents", "outputStyles", "themes"];
  if (claude && entry.strict === false && components.some((key) => has(entry[key]))) throw new Error("Marketplace entry conflicts with the plugin manifest (strict:false with component declarations)");
  for (const key of ["themes", "monitors", "workflows", "channels", "userConfig", "settings", "types", "experimental"]) {
    if (has(manifest[key]) || (claude && has(entry[key]))) throw new Error(`Claude plugin component is not supported by HIVE: ${key}`);
  }
  if (files.some((file) => /^(?:themes\/|monitors\/|settings\.json$|workflows\/|bin\/)/u.test(file.name))) throw new Error("Claude plugin contains unsupported theme, monitor, settings, PATH executable or workflow components");
  const warnings = new Set<string>();
  const outputStylePaths = new Set<string>();
  const hasDeclaredOutputStyles = manifest.outputStyles !== undefined || (claude !== undefined && entry.strict !== false && entry.outputStyles !== undefined);
  const declaredOutputStyleRoots = [...paths(manifest.outputStyles, "outputStyles"), ...(claude && entry.strict !== false ? paths(entry.outputStyles, "marketplace outputStyles") : [])];
  for (const root of hasDeclaredOutputStyles ? declaredOutputStyleRoots : ["output-styles"]) {
    const matches = files.filter((file) => file.name.endsWith(".md") && (file.name === root || file.name.startsWith(root ? `${root}/` : "")));
    if (declaredOutputStyleRoots.includes(root) && !matches.length) throw new Error(`Declared output style path has no Markdown files: ${root || "."}`);
    for (const file of matches) outputStylePaths.add(file.name);
  }
  if (outputStylePaths.size > 128) throw new Error("Plugin output styles exceed 128 files");
  const outputStyleNames = new Set<string>();
  for (const file of files.filter((candidate) => outputStylePaths.has(candidate.name))) {
    const parsed = parsePluginOutputStyle(pluginMarkdown(new TextDecoder("utf-8", { fatal: true }).decode(file.bytes), destination, `Output style ${file.name}`), file.name);
    if (outputStyleNames.has(parsed.key.toLowerCase())) throw new Error(`Duplicate output style key: ${parsed.key}`);
    outputStyleNames.add(parsed.key.toLowerCase());
    for (const warning of parsed.warnings) warnings.add(warning);
  }
  const dependencies = parsePluginDependencies(entry.dependencies ?? manifest.dependencies);
  const pluginVersion = entry.version === undefined && manifest.version === undefined ? undefined : string(entry.version ?? manifest.version, "Claude plugin version", 256);
  if (dependencies.length) warnings.add("Plugin dependencies require separately installed, enabled and trusted matching HIVE plugins; HIVE never installs or enables dependencies automatically.");
  const skillPaths = new Set<string>();
  // A root-sourced catalog entry can expose one package from a shared skills
  // repository; loading every default skill would cross that package boundary.
  const scopedRootSkills = (entry.source === "." || entry.source === "./") && entry.skills !== undefined;
  const declaredSkillRoots = scopedRootSkills ? paths(entry.skills, "marketplace skills") : [...paths(manifest.skills, "skills"), ...(claude && entry.strict !== false ? paths(entry.skills, "marketplace skills") : [])];
  for (const root of [...(scopedRootSkills ? [] : ["skills"]), ...declaredSkillRoots]) {
    const direct = root ? `${root}/SKILL.md` : "SKILL.md";
    const matches = files.filter((file) => file.name === direct || (file.name.startsWith(root ? `${root}/` : "") && path.posix.basename(file.name) === "SKILL.md" && file.name.split("/").length === (root ? root.split("/").length : 0) + 2));
    for (const file of matches) skillPaths.add(file.name);
    if (declaredSkillRoots.includes(root) && !matches.length) throw new Error(`Declared skill path has no SKILL.md: ${root || "."}`);
  }
  if (!scopedRootSkills && manifest.skills === undefined && !files.some((file) => file.name.startsWith("skills/")) && files.some((file) => file.name === "SKILL.md")) skillPaths.add("SKILL.md");
  const additions: TreeFile[] = [];
  const commands: Array<{ name: string; content: string; description: string; sourcePath?: string; argumentHint?: string }> = [];
  const addCommand = (commandName: string, content: string, description = "Imported Claude command", sourcePath?: string, argumentHint?: string) => {
    identifier(commandName, "command name");
    if (commands.some((command) => command.name.toLowerCase() === commandName.toLowerCase())) throw new Error(`Duplicate Claude command: ${commandName}`);
    commands.push({ name: commandName, content, description, ...(sourcePath === undefined ? {} : { sourcePath }), ...(argumentHint === undefined ? {} : { argumentHint }) });
  };
  const addCommandPaths = (value: unknown, defaults = false) => {
    for (const root of paths(value, "commands")) {
      const matches = files.filter((file) => file.name.endsWith(".md") && (root ? file.name === root || file.name.startsWith(`${root}/`) : !file.name.includes("/")));
      if (!matches.length && !defaults) throw new Error(`Declared command path does not exist: ${root}`);
      for (const file of matches) addCommand(path.posix.basename(file.name, ".md"), new TextDecoder("utf-8", { fatal: true }).decode(file.bytes), undefined, file.name);
    }
  };
  const addCommands = (value: unknown) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const [commandName, raw] of Object.entries(object(value, "commands"))) {
        const command = object(raw, "command"); keys(command, ["source", "content", "description", "argumentHint", "model", "allowedTools"], "command");
        if ((command.source === undefined) === (command.content === undefined)) throw new Error(`Command ${commandName} requires exactly one of source or content`);
        if (command.content !== undefined && typeof command.content !== "string") throw new Error(`Command ${commandName} content must be a string`);
        const sourcePath = command.source === undefined ? undefined : bundlePath(string(command.source, "command source"));
        if (sourcePath !== undefined && !sourcePath.endsWith(".md")) throw new Error(`Command ${commandName} source must be a Markdown file`);
        const source = sourcePath === undefined ? undefined : files.find((file) => file.name === sourcePath);
        const content = typeof command.content === "string" ? command.content : source ? new TextDecoder("utf-8", { fatal: true }).decode(source.bytes) : undefined;
        if (content === undefined) throw new Error(`Missing command source: ${commandName}`);
        for (const key of ["description", "argumentHint", "model"]) if (command[key] !== undefined) string(command[key], `Command ${commandName} ${key}`);
        if (command.allowedTools !== undefined && (!Array.isArray(command.allowedTools) || command.allowedTools.length > 128 || command.allowedTools.some((tool) => typeof tool !== "string" || !tool.trim()))) throw new Error(`Command ${commandName} allowedTools must be an array of tool names`);
        for (const key of ["model", "allowedTools"]) if (command[key] !== undefined) warnings.add(`Command ${commandName}: ${key} is instruction metadata only; HIVE provider, permissions and explicit skill selection apply.`);
        addCommand(commandName, content, typeof command.description === "string" ? command.description : undefined, sourcePath, typeof command.argumentHint === "string" ? command.argumentHint : undefined);
      }
    } else addCommandPaths(value);
  };
  if (manifest.commands === undefined) addCommandPaths("commands", true); else addCommands(manifest.commands);
  if (claude && entry.strict !== false && entry.commands !== undefined) addCommands(entry.commands);
  for (const command of commands) {
    const file = `.hive-imported/commands/${command.name}/SKILL.md`;
    const parsed = markdownContent(command.content, `Command ${command.name}`, warnings);
    if (/!`/u.test(parsed.body)) warnings.add(`Command ${command.name}: Claude shell preprocessing is not executed by HIVE; rewrite it using approved agent tools before invocation.`);
    const description = command.description === "Imported Claude command" ? parsed.description ?? command.description : command.description;
    const referenceBase = command.sourcePath === undefined ? "." : path.posix.dirname(command.sourcePath);
    const referenceContext = `HIVE imported command reference context: original source ${JSON.stringify(command.sourcePath ?? "inline plugin manifest")}; resolve relative links from plugin-root directory ${JSON.stringify(referenceBase)}. Use read_skill_reference with this skillId and scope: "plugin" for a normalized plugin-root-relative path, or an absolute path inside this plugin.\n\n`;
    const argumentHint = command.argumentHint ?? parsed.argumentHint;
    const invocationFields = `${parsed.disableModelInvocation === undefined ? "" : `disable-model-invocation: ${parsed.disableModelInvocation}\n`}${parsed.userInvocable === undefined ? "" : `user-invocable: ${parsed.userInvocable}\n`}${argumentHint === undefined ? "" : `argument-hint: ${JSON.stringify(argumentHint)}\n`}`;
    additions.push({ name: file, bytes: Buffer.from(`---\nname: ${command.name}\ndescription: ${JSON.stringify(description)}\n${invocationFields}---\n${referenceContext}${pluginMarkdown(parsed.body, destination, `Command ${command.name}`)}`), executable: false }); skillPaths.add(file);
  }
  const servers: Record<string, unknown> = {};
  const substitute = (value: string) => value.replaceAll("${CLAUDE_PLUGIN_ROOT}", destination);
  const addServerMap = (raw: unknown) => {
    const configuration = object(raw, "Claude MCP servers");
    if (Object.keys(configuration).length > 32) throw new Error("At most 32 MCP servers may be configured per scope");
    for (const [serverName, serverRaw] of Object.entries(configuration)) {
      identifier(serverName, "server name");
      const server = object(serverRaw, "Claude MCP server");
      keys(server, ["type", "transport", "command", "args", "env", "envRefs", "url", "headers", "oauth", "timeoutMs"], "Claude MCP server");
      if (server.type !== undefined && server.transport !== undefined && server.type !== server.transport) throw new Error("MCP type and transport must agree");
      const transport = server.type ?? server.transport;
      if (server.url !== undefined) {
        if (transport !== undefined && transport !== "http") throw new Error("Only Streamable HTTP MCP servers are supported");
        if (["command", "args", "env", "envRefs"].some((key) => server[key] !== undefined)) throw new Error("Imported HTTP MCP servers cannot declare process fields");
        const url = string(server.url, "MCP URL");
        if (url.includes("${")) throw new Error("Imported MCP URLs cannot contain unresolved configuration variables");
        const headers = server.headers === undefined ? {} : object(server.headers, "MCP headers");
        let bearerTokenEnv: string | undefined;
        for (const [header, value] of Object.entries(headers)) {
          const match = typeof value === "string" ? /^Bearer \$\{([A-Za-z_][A-Za-z0-9_]*)\}$/u.exec(value) : null;
          if (header.toLowerCase() !== "authorization" || !match) throw new Error("Imported MCP HTTP headers must use Authorization: Bearer ${ENV_NAME}");
          if (bearerTokenEnv) throw new Error("Imported MCP HTTP headers cannot repeat Authorization");
          bearerTokenEnv = match[1];
        }
        servers[serverName] = { transport: "http", url, ...(bearerTokenEnv ? { bearerTokenEnv } : {}), ...(server.oauth === undefined ? {} : { oauth: server.oauth }), ...(server.timeoutMs === undefined ? {} : { timeoutMs: server.timeoutMs }) };
      } else {
        if (transport !== undefined && transport !== "stdio") throw new Error("Only stdio or HTTP MCP servers are supported");
        if (["headers", "oauth"].some((key) => server[key] !== undefined)) throw new Error("Imported stdio MCP servers cannot declare HTTP fields");
        const envRefs: Record<string, string> = {};
        const env: Record<string, string> = {};
        for (const [key, value] of Object.entries(server.env === undefined ? {} : object(server.env, "MCP env"))) {
          if (key.toLowerCase() === "__proto__") throw new Error("Imported MCP environment names cannot use __proto__");
          if (typeof value === "string" && /\$\{(?:CLAUDE_PLUGIN_DATA|CLAUDE_PROJECT_DIR|user_config\.)/u.test(value)) throw new Error("Imported MCP environment values use unsupported Claude data, project or user configuration interpolation");
          const match = typeof value === "string" ? /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/u.exec(value) : null;
          if (match && match[1] !== "CLAUDE_PLUGIN_ROOT") envRefs[key] = match[1];
          else {
            if (typeof value !== "string") throw new Error("Imported MCP environment values must be strings");
            const expanded = substitute(value);
            if (expanded.includes("${")) throw new Error("Imported MCP environment values require a whole ${ENV_NAME} reference or a literal with ${CLAUDE_PLUGIN_ROOT}");
            env[key] = validateEnvironmentLiteral(key, expanded);
          }
        }
        if (server.envRefs !== undefined) for (const [key, value] of Object.entries(object(server.envRefs, "MCP envRefs"))) {
          if (key.toLowerCase() === "__proto__") throw new Error("Imported MCP environment names cannot use __proto__");
          if (Object.hasOwn(envRefs, key) || Object.hasOwn(env, key)) throw new Error("Imported MCP environment references cannot override environment values");
          envRefs[key] = string(value, "MCP environment reference", 128);
        }
        if (Object.keys(envRefs).some((key) => key.toLowerCase() === "claude_plugin_root") || Object.entries(env).some(([key, value]) => key.toLowerCase() === "claude_plugin_root" && (key !== "CLAUDE_PLUGIN_ROOT" || value !== destination))) throw new Error("Imported MCP CLAUDE_PLUGIN_ROOT is fixed to the installed plugin directory");
        env.CLAUDE_PLUGIN_ROOT = validateEnvironmentLiteral("CLAUDE_PLUGIN_ROOT", destination);
        const args = server.args ?? [];
        if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) throw new Error("MCP args must be strings");
        const command = substitute(string(server.command, "MCP command"));
        const expandedArgs = args.map((arg) => substitute(arg));
        if ([command, ...expandedArgs].some((value) => value.includes("${"))) throw new Error("Imported MCP command and args support only ${CLAUDE_PLUGIN_ROOT}; use env for credential references");
        servers[serverName] = { transport: "stdio", command, args: expandedArgs, cwd: ".", envRefs, ...(Object.keys(env).length ? { env } : {}), ...(server.timeoutMs === undefined ? {} : { timeoutMs: server.timeoutMs }) };
      }
    }
  };
  const addServers = (raw: unknown) => {
    if (raw === undefined) return;
    const entries = Array.isArray(raw) ? raw : [raw];
    if (entries.length > 128) throw new Error("MCP configuration has too many sources");
    for (const entry of entries) {
      if (typeof entry === "string") {
        if (/\.(?:mcpb|dxt)$/iu.test(entry) || /^https?:/u.test(entry)) throw new Error("MCP binary bundles and bundle downloads are not supported; provide a pinned JSON server configuration");
        const fileName = bundlePath(entry);
        if (!fileName.endsWith(".json")) throw new Error("Imported MCP configuration paths must name .json files");
        const file = files.find((candidate) => candidate.name === fileName);
        if (!file) throw new Error(`Missing MCP configuration: ${fileName}`);
        const configuration = json(file); addServerMap(configuration.mcpServers ?? configuration);
      } else addServerMap(entry);
    }
  };
  const defaultMcp = files.find((file) => file.name === ".mcp.json"); if (defaultMcp) { const value = json(defaultMcp); addServerMap(value.mcpServers ?? value); }
  addServers(manifest.mcpServers);
  const hooks = importClaudeHooks(files, destination, [manifest.hooks, ...(claude && entry.strict !== false ? [entry.hooks] : [])]);
  const pluginComponents = convertClaudeAgentLspComponents(files, manifest, entry, destination);
  for (const warning of pluginComponents.warnings) warnings.add(warning);
  if (!skillPaths.size && !Object.keys(servers).length && !Object.keys(hooks).length && !pluginComponents.agents.length && !Object.keys(pluginComponents.lspServers).length && !outputStylePaths.size) warnings.add("Plugin declares no supported contributions.");
  const imported = { version: 1, name, description: typeof entry.description === "string" ? entry.description : manifest.description, ...(pluginVersion === undefined ? {} : { pluginVersion }), ...(dependencies.length ? { dependencies } : {}), skills: [...skillPaths], mcpServers: servers, hooks, agents: pluginComponents.agents, lspServers: pluginComponents.lspServers, outputStyles: [...outputStylePaths] };
  additions.push({ name: "hive.plugin.json", bytes: Buffer.from(JSON.stringify(imported, null, 2)), executable: false });
  const names = new Set(files.map((file) => file.name.toLowerCase()));
  for (const file of additions) if (names.has(file.name.toLowerCase())) throw new Error(`Imported component collides with an existing file: ${file.name}`); else names.add(file.name.toLowerCase());
  const converted = files.map((file) => {
    if (!file.name.endsWith(".md")) return file;
    let content = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
    if (skillPaths.has(file.name)) {
      const parsed = markdownContent(content, `Skill ${file.name}`, warnings);
      pluginMarkdown(content, destination, `Skill ${file.name}`);
      if (file.name === "SKILL.md" && !/^name:[ \t]*\S/mu.test(content.slice(0, content.length - parsed.body.length))) content = `---\nname: ${name}\ndescription: ${JSON.stringify(parsed.description ?? "Imported Claude plugin instructions")}\n---\n${parsed.body}`;
    }
    return { ...file, bytes: Buffer.from(content.replaceAll("${CLAUDE_PLUGIN_ROOT}", destination.replaceAll("\\", "/"))) };
  });
  return { files: [...converted, ...additions], warnings: [...warnings] };
}
