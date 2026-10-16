# CLI extensions

HIVE reads workspace extension configuration from `.hive/extensions.json`. Discovery is local and inert: listing or validating extensions does not launch commands, run hooks, load skill instructions into the model, or contact MCP servers.

Executable contributions require both trust and enablement. A repository cannot grant itself trust. HIVE records explicit trust decisions outside the repository, under `~/.hive/extension-trust/`, scoped to the canonical workspace path and contribution fingerprint. Configuration edits and skill content edits require fresh trust. Trusting a plugin also records trust for its current declared contributions; enabling or disabling that plugin applies to the whole bundle.

## Configure and inspect

```json
{
  "version": 1,
  "mcpServers": {
    "local-tools": {
      "transport": "stdio",
      "command": "node",
      "args": ["tools/mcp-server.mjs"],
      "cwd": ".",
      "envRefs": { "SERVICE_TOKEN": "MY_SERVICE_TOKEN" },
      "timeoutMs": 30000,
      "enabled": false
    },
    "remote-tools": {
      "transport": "http",
      "url": "https://tools.example.com/mcp",
      "bearerTokenEnv": "MY_MCP_TOKEN",
      "enabled": false
    }
  },
  "hooks": {
    "report": {
      "event": "session_end",
      "command": "node",
      "args": ["tools/session-report.mjs"],
      "timeoutMs": 1000,
      "enabled": false
    }
  },
  "plugins": {
    "team-tools": { "path": "plugins/team-tools", "enabled": false }
  }
}
```

Commands exposed by the CLI/TUI dispatcher:

```text
/mcp list
/mcp validate
/mcp trust local-tools
/mcp enable local-tools
/mcp doctor local-tools
/mcp login remote-tools
/mcp auth-status remote-tools
/mcp logout remote-tools
/mcp tools local-tools
/mcp call local-tools tool_name {"argument":"value"}
/mcp resources local-tools
/mcp resource-templates local-tools
/mcp read local-tools fixture://docs/readme
/mcp prompts local-tools
/mcp prompt local-tools review {"code":"source text"}
/mcp complete local-tools {"reference":{"type":"ref/prompt","name":"review"},"argument":{"name":"code","value":"py"}}
/mcp watch remote-tools
/mcp subscribe remote-tools fixture://docs/readme
/mcp task-call local-tools long_operation {"argument":"value"}
/mcp tasks local-tools
/mcp task local-tools task-id
/mcp task-result local-tools task-id
/mcp task-cancel local-tools task-id
/mcp disable local-tools
/mcp untrust local-tools

/skills list
/skills trust skill-name
/skills show skill-name

/plugins list
/plugins marketplace add anthropics/claude-plugins-official
/plugins marketplace list claude-plugins-official
/plugins install commit-commands@claude-plugins-official
/plugins install team-tools "plugins/team-tools"
/plugins trust team-tools
/plugins enable team-tools
/plugins agents
/plugins agent agent:team-tools.reviewer
/plugins run-agent agent:team-tools.reviewer Inspect the changes
/plugins use-agent agent:team-tools.reviewer
/plugins use-agent off
/plugins uninstall team-tools

/lsp list
/lsp doctor lsp:team-tools.typescript
/lsp hover lsp:team-tools.typescript "src/file with spaces.ts" 0 0
/lsp use lsp:team-tools.typescript
/lsp use off

/hooks list
/hooks trust report
/hooks enable report
```

MCP, skills, plugins and hooks support `help`, `list`, `validate`, `trust`, `untrust`, `enable`, and `disable`. LSP supports inspection/state commands and `doctor`, rather than `validate`. MCP `doctor` initializes a real connection and lists its tools. `call` performs the requested tool operation; extension trust is not a claim that a remote tool is read only. The agent runtime must retain its normal approval checks for dynamically exposed tool calls.

Credentials use environment variable references, never inline values. Process `env` maps may contain explicit non-secret settings such as `NODE_ENV: "production"`; credential-named fields, recognizable credentials and credential-bearing URL settings require `envRefs`. Both maps together have at most 32 entries, with no case-insensitive collisions. Child environments include a small infrastructure allowlist plus these explicit values/references; they do not inherit the complete HIVE/provider environment. Bearer credentials in URLs, credential command flags, unknown fields and known credential patterns are rejected. HTTP requests omit browser credentials, refuse redirects, and accept HTTPS or HTTP to `localhost`, `127.0.0.1`, or `[::1]`. MCP endpoint URLs cannot contain query strings or fragments.

Commands run with `shell: false` and hidden Windows process windows. Use a real executable such as `node` or an absolute executable path; shell expressions and Windows `.cmd` launchers are not expanded. Process working directories and plugin contribution paths resolve inside their owning workspace or plugin directory, including symlink checks. Trust allows the configured executable to access the operating system with the user's privileges; HIVE does not provide an operating system sandbox for extensions.

## Skills

Place a bounded UTF-8 `SKILL.md` in one of:

```text
.hive/skills/<name>/SKILL.md
.agents/skills/<name>/SKILL.md
.claude/skills/<name>/SKILL.md
.codex/skills/<name>/SKILL.md
skills/<name>/SKILL.md
skills/<package>/skills/<name>/SKILL.md
```

The wrapper form supports the existing vendored `hive-mind-council` package. An optional `skillDirectories` array in configuration adds at most 16 workspace directories using the same one-wrapper-level discovery. HIVE does not recursively search arbitrary documentation. Each skill body is limited to 64 KiB. A simple frontmatter `name` and single-line `description` are read for discovery; the original file remains intact. Block-style descriptions currently use the literal first line; full YAML parsing is not implemented.

Trust binds to the canonical path and complete file content. `loadSkill()` rereads and rechecks content before returning it to the caller. Skill loading adds instructions only when the caller deliberately requests that skill; a skill cannot expand the user's authorization.

Selected skills also expose the read-only `read_skill_reference` tool. It accepts a selected skill id and a relative Markdown/text instruction path, resolves inside that skill directory in the original workspace, and rechecks trust before and after the bounded UTF-8 read. Private paths, escapes, hard links and oversized files fail clearly. References are limited to 64 KiB; the existing agent result budget may visibly truncate long content. This does not execute scripts or automatically load unrelated files.

For a selected plugin skill, explicit `scope: "plugin"` permits a Markdown/text
reference within its own currently trusted enabled plugin root. It accepts
plugin-relative paths or absolute installed-root paths, including interpolated
`${CLAUDE_PLUGIN_ROOT}` references. Default scope remains the skill directory.
Private-path, real-path, hard-link, size and post-read trust checks still apply;
other workspace files and other plugin roots remain unavailable. Imported
commands retain their original source/reference directory in their instructions.

## Local plugin bundles

A configured plugin directory contains `hive.plugin.json`:

```json
{
  "version": 1,
  "name": "team-tools",
  "description": "Team repository tools",
  "skills": ["skills/team-review/SKILL.md"],
  "agents": ["agents/reviewer.md"],
  "lspServers": {
    "typescript": {
      "command": "node",
      "args": ["tools/language-server.mjs"],
      "extensionToLanguage": { ".ts": "typescript" }
    }
  },
  "mcpServers": {
    "checks": {
      "transport": "stdio",
      "command": "node",
      "args": ["server.mjs"]
    }
  },
  "hooks": {
    "finish": {
      "event": "session_end",
      "command": "node",
      "args": ["finish.mjs"]
    }
  }
}
```

Contributions use scoped ids such as `mcp:team-tools.checks`, `skill:team-tools.team-review`, `hook:team-tools.finish`, `agent:team-tools.reviewer`, `style:team-tools.concise` and `lsp:team-tools.typescript`. They inherit plugin enablement and require current trust. Disabling a bundle blocks all of its contributions. HIVE's native manifest is its own format. The separate [marketplace installer](CLI_MARKETPLACES.md) downloads pinned public Git/local/HTTPS sources and imports compatible Claude skills/commands, output styles, MCP definitions, five hook handler types, agents and stdio LSP declarations. Unsupported forms fail explicitly. Installation never executes plugin code or install scripts. See [advanced protocols](CLI_PROTOCOLS.md) for invocation and compatibility details.

### Install and uninstall an existing local bundle

Run `/plugins install <name> <workspace-directory>` in the terminal UI, or `hive plugins install <name> <workspace-directory>` from the CLI. Quote directories containing spaces. The directory must already exist inside the canonical workspace and contain a version 1 `hive.plugin.json` whose `name` matches the command. HIVE validates the entire existing configuration and every declared contribution before registering the directory in `.hive/extensions.json`.

Installation only registers existing files. It performs no network access, copying, package installation, subprocess execution, or install scripts. A new registration and its contributions start disabled and untrusted, including when old trust entries exist from a previous manual unregistration. Inspect the bundle before using the separate `trust` and `enable` commands. An existing registration must be explicitly uninstalled before its path can change.

`/plugins uninstall <name>` removes the registration and revokes trust for the bundle and its declared contributions. It preserves all plugin source files and unrelated configuration, and can unregister a broken or deleted target bundle while still validating remaining contributions. Reinstalling the directory requires fresh trust and enablement.

Configuration and trust updates are bounded. Cooperative registration and trust commands share `.hive/extensions.lock`. Updates displace existing files into retained `.NAME.PID.UUID.backup` inodes, validate the displaced bytes and publish exclusively without overwriting a recreated destination. Conflicts identify the recoverable backup. Successful updates retain backups as well, so later writes through an already-open descriptor remain recoverable. This requires filesystem hard-link support and is not a portable compare-and-swap operation. Storage aliases and symlink configuration/manifest files are rejected. Interrupted writer locks are retained for explicit inspection; HIVE never steals a lock automatically.

For manually registered local bundles, trust fingerprints bind to declarations and skill bodies, not every transitive file executed by a plugin. Inspect scripts and dependencies before trusting a local bundle; edits to its helper scripts are not automatically detected as manifest changes. Managed marketplace bundles additionally bind to their provenance and complete imported file tree, so source drift fails discovery and requires an explicit update and fresh trust.

## Lifecycle hooks

Supported event names are `session_start`, `prompt_submit`, `before_tool`, `after_tool`, `after_tool_failure` and `session_end`. The CLI invokes session_start/prompt_submit/session_end around each coding attempt, including an attempt that pauses; tool events wrap the affected attempt. Claude PostToolUse runs only on success and PostToolUseFailure only on failure; native after_tool retains its existing outcome behavior. Ending-hook failures retain the primary coding error when both fail. No hook runs as a side effect of discovery, configuration validation, or trust commands.

Each process receives one JSON value on stdin:

```json
{ "event": "session_end", "input": { "sessionId": "example" } }
```

Only trusted, enabled matching hooks run, sequentially. The host reports their actual exit code, output, timeout, spawn error, or output-limit error. Input and combined output are each bounded to 64 KiB. Native per-hook timeouts range from 100 ms to 120 seconds. Claude command events retain their 30-second bounds; events with agent handlers allow an aggregate 120 seconds. HTTP handlers require trusted explicit endpoint/header configuration; prompt/agent/MCP tool handlers additionally require fresh host approval for model/tool work. All have bounded lifetimes. Supported decision output can block, stop or request bounded continuation and append labelled context; it cannot grant permissions or rewrite tool input. `continue:false` stops later handlers for the event. Cancellation terminates the owned live process group/tree; independently detached daemons are outside this guarantee. See [Claude hook compatibility](CLI_PROTOCOLS.md#claude-hooks).

## MCP support and limits

Implemented and fixture tested:

- Modern `2026-07-28` discovery/per-request metadata and capability negotiation, alongside legacy initialize/initialized for `2025-11-25`, `2025-06-18` and `2025-03-26`. Recognized modern protocol failures never silently downgrade.
- stdio newline-delimited UTF-8 and Streamable HTTP POST responses as JSON/SSE. Modern requests use mirrored protocol/method/tool/annotated headers and bounded MRTR input continuations; modern subscriptions use correlated acknowledged POST/stdin streams. Legacy HTTP retains opt-in background GET, bounded Last-Event-ID reconnect, interrupted POST-stream recovery through GET without POST replay, session/protocol headers and bounded DELETE cleanup.
- Paginated `tools/list`, `tools/call`, server pings, unsupported client-request errors, cancellation notifications, request timeouts, correlation, process cleanup, and output bounds.
- Paginated resources and resource templates, resource text/binary reads, prompt catalogs and retrieval, and contextual argument completion. Methods require the corresponding advertised server capability. Resource URIs are passed only to the selected MCP server; HIVE never opens or fetches them directly.
- Advertised tool/resource/prompt list-change notifications over stdio and in-band HTTP POST SSE. Catalog calls fetch fresh lists. Agent tool definitions refresh before the next model turn; observed schema changes invalidate pending approval and are checked again immediately before transport send.
- Explicit roots capability: `connectMcp(..., { roots: true })` or `--share-root` immediately after the server id. Only the canonical project root is returned as a `file://` URI, with trust rechecked for each server request. The consent choice is fixed at connection initialization. Root sharing is off by default and is never enabled automatically for coding agents.
- [HTTP OAuth](CLI_OAUTH.md) with discovery, S256 PKCE, explicit consent URL, protected loopback callback, encrypted Windows DPAPI storage, refresh/rotation and logout. No external account consent has been exercised in the local suite.
- Resource subscriptions and update notifications; explicit watch/subscribe commands retain the connection until cancellation. Updates do not automatically read or open resource URIs.
- Legacy experimental `2025-11-25` tasks retain required/optional tool task support, creation, list/status/result/cancel and task-status notifications. The modern `io.modelcontextprotocol/tasks` extension separately supports server-directed handles, inline status/results/errors, approved `tasks/update` input, cancellation acknowledgements and task-ID subscriptions. No automatic polling/replay or claim that a working task is complete. Modern task enumeration is unavailable; retain returned IDs.
- Opt-in text sampling through the explicitly selected provider/model, with separate approval before generation and output release, bounded request/token budgets and fallback disabled. Interactive TUI form/URL elicitation requires a human response; headless calls without a host callback decline. Credentials belong in the URL authorization flow, never form fields.
- Up to 32 concurrent requests per connection, 128 tools, 16 list pages, 256 content blocks per result, and 1 MiB per transport request/response. Configuration/manifests are limited to 128 KiB. No tool call is automatically replayed after failure.

Advanced catalogs are bounded to 16 pages, 256 entries and 1 MiB cumulatively.
Resource reads and prompt results allow at most 256 content blocks/messages;
prompt arguments allow 128 entries and 64 KiB combined; completions return at
most 100 values. Selected standard fields and supported content variants are
validated; icons, annotations and unknown extension metadata are not preserved.
Text, base64 image/audio, embedded resources and resource links can be retrieved
through the API. This does not establish native model vision or audio handling.

Explicit CLI/TUI reads and prompt retrieval display returned data; they do not
automatically run the prompt. In auto mode, selected servers advertise separate
resource/prompt/completion context tools to agents, including servers without
tools. Every agent context request requires interactive approval, and returned
messages remain untrusted data rather than system instructions. All new TUI
network operations use cancellable task handles.

Not implemented: legacy HTTP+SSE endpoint negotiation, arbitrary event-history replay, sampling tools/ambient repository context, general JSON Schema elicitation, server instructions injection or unimplemented extensions. Sampling and elicitation capabilities are advertised only when the integrating host supplies their permission/input callbacks. OAuth currently requires public discovery endpoints and one advertised authorization server; non-Windows embedding hosts must supply an OS-backed cipher. An expired legacy HTTP session produces a reconnect error; callers must establish a fresh connection before a deliberate retry. Independently daemonized descendants remain outside process cleanup guarantees. See [advanced protocol bounds and commands](CLI_PROTOCOLS.md). These are explicit compatibility limits rather than claims of full MCP or competitor parity.

Protocol references: [MCP lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle), [MCP transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports), and [MCP tools](https://modelcontextprotocol.io/specification/2025-06-18/server/tools).

Advanced operation references: [resources](https://modelcontextprotocol.io/specification/2025-11-25/server/resources), [prompts](https://modelcontextprotocol.io/specification/2025-11-25/server/prompts), [completion](https://modelcontextprotocol.io/specification/2025-11-25/server/utilities/completion) and [roots](https://modelcontextprotocol.io/specification/2025-11-25/client/roots).

## Runtime integration API

The source entry point is `src/extensions/index.ts`:

```ts
discoverExtensions(cwd, options?)
loadSkill(cwd, id, options?)
loadPluginAgent(cwd, id, options?)
loadLspServer(cwd, id, options?)
readSkillReference(cwd, skillId, relativePath, options?)
installLocalPlugin(cwd, name, directory, options?)
uninstallLocalPlugin(cwd, name, options?)
marketplaceCommand(cwd, args, options?)
installMarketplacePlugin(cwd, "plugin@marketplace", options?)
beginMcpOAuthLogin(cwd, id, options?)
getMcpOAuthStatus(cwd, id, options?)
logoutMcpOAuth(cwd, id, options?)
setExtensionState(cwd, id, "trust" | "untrust" | "enable" | "disable", options?)
connectMcp(cwd, id, { signal?, timeoutMs?, trustStateDir? })
runHooks(cwd, event, input, { signal?, trustStateDir?, claudeHookHost? })
extensionCommand(cwd, "mcp" | "skills" | "plugins" | "hooks" | "lsp", args, options?)
```

`connectMcp()` returns `capabilities`, `listTools()`, `callTool()`,
`listResources()`, `listResourceTemplates()`, `readResource()`, `listPrompts()`,
`getPrompt()`, `complete()`, `onListChanged()`, `startBackground()`,
`stopBackground()`, `subscribeResource()`, `unsubscribeResource()`,
`onResourceUpdated()`, `callToolTask()`, `getTask()`, `listTasks()`,
`getTaskResult()`, `cancelTask()`, `updateTask()`, `subscribeTask()`,
`unsubscribeTask()`, `onTaskStatus()` and idempotent `close()`.
Modern `callTool()`/`callToolTask()` return either a normal tool result or
`{task: handle}`. Modern cancellation returns `{taskId, cancellationRequested:true}`,
which acknowledges the request without asserting terminal state. Legacy result
and cancellation shapes remain available on the legacy lifecycle.
`onListChanged(listener)` returns an unsubscribe function; close also releases
listeners. Always close connections in `finally`; request cancellation does not
replace connection cleanup. `RequestOptions.beforeSend` is an optional trusted
host callback run synchronously immediately before transport send, after async
credential preparation. It can refuse a stale approved request without sending
it. Repository configuration cannot declare this callback.
`trustStateDir` is an explicit dependency used by fixtures to isolate runtime
state, and is not read from repository config. The host deliberately avoids
connecting just to populate a menu. All extension results remain untrusted data.

Run the local fixture suite after building current core sources:

```text
node --test --test-reporter=spec tests/cli-extensions.test.mjs
node --test --test-reporter=spec tests/cli-plugin-install.test.mjs
node --test --test-reporter=spec tests/cli-marketplace.test.mjs tests/mcp-oauth.test.mjs tests/cli-extension-workflows.test.mjs
```

The fixtures launch temporary local Node/Git processes and loopback HTTP servers; they do not use real account tokens, alter actual workspace trust, or contact a provider. The separate live marketplace download/install evidence is documented in [CLI_MARKETPLACES.md](CLI_MARKETPLACES.md).

The 2026-10-16 advanced continuation passed 80/80 focused checks and 866/866
integrated core tests, plus lint and core/desktop-shell/worker builds. Source
fingerprints, command evidence and remaining limits are recorded in
`test-results/cli-advanced-extensions-verification.json`. New regression files:
`mcp-advanced`, `mcp-context-integration`, `marketplace-compatibility` and
`secret-redaction-bounds` under `tests/`. The native terminal renderer and
packaged application were not visually retested for this protocol-only pass.

The 2026-10-17 background/client-host/plugin runtime continuation passed 940/940
core tests, 22/22 actual local CLI/Queen/TUI/host workflows and 11/11 hook
regressions, plus lint and core/desktop-shell/worker builds. Native Windows
ConPTY exercised private form/manual URL input at 80 and 48 columns, with actual
Node/shell exit 0 and unchanged UI hashes. The 262-file source snapshot and
qualified evidence are in `test-results/cli-final-protocols-verification.json`;
earlier failed runs remain preserved. A separate intermittent repair/pause test
failure remains unexplained despite passing targeted/full-file/final-core runs;
enhanced diagnostics are retained. See [the parity record](HIVE_CLI_PARITY.md).

The subsequent modern lifecycle/compatibility continuation passed 993/993 core
tests, zero failures/skips, in 334.0 seconds. Modern/legacy MCP focused checks
passed 99/99, plugin runtime/parser checks 16/16 and persistence/session checks
29/29. A real Windows sharing lock now pauses/resumes correctly with one Fixer;
guarded retries preserve detected foreign checkpoints through failure cleanup.
The 268-file snapshot and retained earlier failures are in
`test-results/cli-modern-compat-verification.json`. See [modern protocols and
dependency policy](CLI_PROTOCOLS.md) for exact supported wire and plugin forms.
