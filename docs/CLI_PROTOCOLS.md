# Advanced MCP and Claude plugin compatibility

HIVE implements the following operations through the existing coding runtime and extension trust store. Discovery, installation and selection remain inert. Inspect the bundle, then explicitly trust and enable its contributions before invoking them. Examples use TUI slash commands; omit the leading slash for the standalone `hive` CLI. Agent/LSP selection commands (`use-agent` and `lsp use`) belong to the TUI conversation.

## MCP lifecycle versions

HIVE supports the **2026-07-28** lifecycle alongside the legacy `2025-11-25`, `2025-06-18` and `2025-03-26` lifecycles. A bounded read-only discovery probe selects the protocol era. Legacy servers retain initialize/initialized negotiation; recognized modern errors fail visibly rather than silently downgrading.

Modern servers use `server/discover` and per-request protocol/client capability metadata. Streamable HTTP mirrors the version, method and applicable tool name into the required headers. Valid `x-mcp-header` tool annotations are translated with bounded schema/value checks and the protocol's base64 sentinel; invalid HTTP tool header declarations are filtered explicitly. Modern HTTP is stateless: no MCP session cookie/header, DELETE cleanup, background GET or Last-Event-ID resumption. Cancellation closes the current response; a transport failure never resends a tool POST.

Modern server-to-client input uses bounded multi-round request/response continuations (MRTR). HIVE routes explicit sampling, elicitation and root requests through its existing consent callbacks, retaining the exact opaque server state. Only a protocol-requested continuation is sent; unrelated operations are never replayed. Limits are 16 input requests per round, eight rounds and the configured request deadline, including time spent awaiting approval. Root sharing remains opt-in. Unsupported extension methods fail explicitly; advertisements alone do not enable them.

## Background MCP streams and subscriptions

```text
/mcp watch remote-tools
/mcp subscribe remote-tools fixture://documents/readme
```

These commands display notifications/progress and cancel cleanly with Escape/Ctrl+C. Legacy HTTP servers use an explicit background GET SSE stream. Event IDs support bounded reconnect with `Last-Event-ID`; an interrupted legacy POST SSE response can resume through GET without reissuing its original request. Modern servers instead use acknowledged, correlated subscriptions over POST/stdin with matching filters and subscription IDs. Unsolicited modern change notifications outside an acknowledged subscription are ignored. Modern SSE ignores obsolete resumption hints and does not automatically replay a closed subscription POST. Unsupported operations, expired legacy sessions, exhaustion and protocol errors surface to the caller.

Resource subscription requires advertised support. Notifications report which resource changed; HIVE does not automatically read it or fetch its URI. The connection API exposes subscribe/unsubscribe and observers for updates, catalog changes, task status and background errors. Subscriptions are scoped to their live connection, not installed as a persistent background service. Agent context subscriptions require ordinary tool approval.

## MCP tasks

```text
/mcp task-call local-tools long_operation {"input":"example"}
/mcp tasks local-tools
/mcp task local-tools task-id
/mcp task-result local-tools task-id
/mcp task-cancel local-tools task-id
/mcp task-continue local-tools task-id
/mcp task-subscribe local-tools task-id
```

The **2025-11-25 experimental tasks** contract retains advertised capabilities, tool `taskSupport`, creation, pagination, status, result, cancellation and related-task metadata. Required task tools return their actual task descriptor to the agent; context tools let it deliberately inspect status/result or cancel. Optional legacy task tools use the explicit task-call command.

A working task is not completed output. HIVE does not poll indefinitely, replay task creation or cancel server work merely because its creation RPC timed out. Explicit cancellation uses `tasks/cancel`; closing a client connection ends local observers. Task availability across subsequent CLI connections depends on the server retaining and exposing that task. Stdio timeout notifications cancel only the pending RPC, not an unknown durable task.

The **2026-07-28 `io.modelcontextprotocol/tasks` extension** is negotiated per request. The server chooses whether an ordinary tool call returns a task handle or immediate output. Handles retain `ttlMs`/`pollIntervalMs`; HIVE never sends the legacy task preference/TTL. `tasks/get` supplies detailed state and inline results/errors. Modern `tasks/list` and `tasks/result` RPCs do not exist: retain the returned ID, then use status/result commands. Cancellation returns an acknowledgement; inspect status separately to establish actual cancellation.

`task-continue` fetches pending input and routes roots, sampling and elicitation through the trusted host's existing approvals before `tasks/update`. CLI callers without the required host callbacks fail explicitly. Answers never appear in the continuation command's return value. Per-connection input fingerprints prevent changed-key reuse and repeated sends; a new connection requires fresh approval. `task-subscribe` uses correlated task-ID filters and cancels with the terminal runtime. Selected agent subscriptions feed a bounded 64-notice/32,000-character queue into actual model context and runtime progress. Stream errors are visible; reconnect is explicit. Subscription filter changes during initial acknowledgement are rejected rather than silently lost.

## Sampling and elicitation

Sampling is available only when the host supplies an approval callback and selected-provider resolver. Interactive coding uses the current builder route: explicit provider/model, output-token cap and **no provider fallback**. Each request requires approval before generation and again before sending generated text to the MCP server. Decline/cancellation returns a protocol error without releasing the text. Only the server's explicit text messages/system prompt enter this request; ambient chat/repository context and sampling tools are unsupported.

Limits include 32 incoming sampling/elicitation requests and 32,768 reserved sampling output tokens per connection, 1–4,096 output tokens per sampling request, 64 messages, 32 content blocks per message and a 64 KiB request envelope. The normal permission UI limits individual review previews to 16,000 characters and refuses larger previews; it does not silently approve omitted text. Actual provider limits still apply. Approval is permission to use the selected provider, so an authenticated BYOK provider can incur its normal charge.

Interactive form elicitation opens a private terminal modal with JSON editing, defaults and validation. Enter submits valid input, Escape cancels; decline is explicit. Flat primitive, enum and bounded array schemas are supported, with at most 32 fields and a 32 KiB schema. Unsupported schema features and credential-like requests fail clearly. The modal warns against entering passwords, keys or tokens. URL elicitation displays an HTTPS authorization link for manual use and explicit accept/decline; it never opens a browser automatically.

Modal drafts and answers are not added to HIVE prompt history, saved conversations or transcripts. A server can include submitted information in later ordinary tool output, which follows the normal tool-output persistence rules. Operating-system terminal capture is outside this claim. Headless operations without an interactive host callback do not advertise elicitation or sampling. Embedding hosts can supply validated input callbacks through `createMcpClientHost`; repository configuration cannot define host callbacks.

## Claude hooks

Supported events map to HIVE lifecycle/tool boundaries: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `SessionEnd`, `Stop`, `StopFailure`, `SubagentStart`, `SubagentStop` and `PermissionRequest`. Successful Claude post-tool hooks run only after success; failure hooks receive the actual error, interruption flag and elapsed execution time. Denied or already-cancelled operations do not start a failure hook. Native HIVE after-tool hooks retain their existing outcome behavior and JSON envelope.

Imported command hooks support bounded literal/glob matchers, direct executable/args and explicit Bash or PowerShell command strings. Windows Bash uses an existing supported Git Bash installation; HIVE does not install one or substitute WSL. Processes use filtered environments, trust checks before launch, separate bounded stdout/stderr and a 30-second event deadline. Cancellation terminates the owned live process group/tree; independently detached daemons are outside this guarantee.

Supported JSON output can append labelled context, block tools or stop the session. `continue:false` prevents subsequent handlers and further model/tool work. Tool input rewriting, permission grants, provider changes and unsupported output directives fail closed. Nonzero exits, malformed output, timeouts and ending-hook failures remain visible. Lifecycle hooks wrap both regular interactive tasks and `hive code`; SessionEnd receives the actual returned session status when available.

Compatible handlers include **command, HTTP, prompt, agent and MCP tool**. Event/type combinations are validated before installation; SessionStart does not support the non-command handlers. HTTP hooks use explicit HTTPS or literal loopback HTTP, pinned DNS, no redirects/cookies/retries, bounded JSON and environment-only credential headers restricted by `allowedEnvVars`. Dispatch-time secret snapshots remain redacted if an environment value rotates while the request is pending.

Prompt hooks use strict `{ok, reason?, impossible?}` decisions; agents use `{ok, reason?}`. They inherit the actual selected provider without fallback; a model override must match that provider's configured models. Every model turn and verifier read requires explicit approval. Agents have up to 50 turns, 100 read calls, eight calls per turn, 2,048 output tokens per model request and 128 KiB history. Verifier tools only read/list/literal-search/raw-diff; private, escaping or linked files are refused. File contents come from bounded identity-checked handles. Raw diff bypasses repository conversion filters and fsmonitor commands.

MCP tool hooks use a separately trusted server, current tool schema and fresh approval; task results cannot substitute for a synchronous decision. Hook execution never automatically signs in to an account. Prompt denial on PreToolUse stops by default; `continueOnBlock` and agent denials return a tool failure while allowing the bounded loop to continue. Stop/SubagentStop denial requests further work; prompt `impossible:true` permits stopping. SubagentStop continues the same agent within its existing turn/tool budgets. Stop creates scoped work and repeats validation/review; plan mode regenerates and validates the saved executable plan. Eight session continuations and the remaining task budget bound this work. SubagentStart adds context; StopFailure is observational and uses `unknown` when a typed provider category is unavailable. PermissionRequest can deny via explicit JSON but cannot approve; exit 2 alone preserves the normal approval flow.

Unlisted events, arbitrary matcher syntax and asynchronous persistent hook services remain unsupported. Headless callers without an approval callback cannot run model/MCP hooks; use interactive HIVE or supply trusted embedding callbacks. Trust authorizes command executables to run with the user's OS privileges; it does not create an OS sandbox.

## Plugin output styles and command arguments

Compatible Claude plugins may declare `outputStyles` as a Markdown path or path
array. Otherwise HIVE scans `output-styles/`. An explicit empty array disables
that default scan. Styles have stable file-derived `style:PLUGIN.KEY` IDs,
bounded name/description/boolean frontmatter and fingerprints covering the body.
Discovery/import are inert; plugin and contribution trust/enable state apply.

```text
/plugins styles
/plugins style style:team.concise
/plugins use-style style:team.concise
/plugins use-style off
hive code "Inspect this project" --output-style style:team.concise
```

Selection persists in the conversation/session and survives forks. It affects
the actual Queen final-response synthesis; structured subagent system prompts
retain their coding contracts. HIVE always keeps engineering, workspace,
permission and evidence rules, including when `keep-coding-instructions` is false.
`force-for-plugin` is inspectable metadata and cannot auto-select a style. The
style is revalidated before and after synthesis; revocation/tampering prevents a
successful styled result. Presentation text does not alter the structured
verdict or validation evidence. This is narrower than Claude's full main-agent
style behavior. Complex/malformed YAML is rejected explicitly.

Canonical `/plugin:skill` commands resolve installed namespaces when unambiguous;
full HIVE skill IDs disambiguate collisions. Explicit invocations expand
`$ARGUMENTS`, zero-based `$ARGUMENTS[N]` and `$N` once, preserving raw argument
text for `$ARGUMENTS` and quoted positional values for indexed forms. Arguments
remain literal text: no shell evaluation or recursive interpolation. A single
backslash escapes a placeholder. Missing indexed values remain literal; when no
substitution occurs, nonempty arguments append once. Expanded context is
ephemeral, rather than making the unexpanded command a persistent selected skill.
Source trust is checked again before each provider call.

```text
/team:inspect "src/file with spaces.ts" review
hive code "Inspect the source" --skill skill:team.inspect --skill-args '"src/file with spaces.ts" review'
```

Imported invocation booleans and argument hints are retained. `user-invocable:
false` blocks explicit invocation, while `disable-model-invocation: true` still
permits an explicit user command. Named `arguments:` declarations fail import
or invocation visibly until supported. Claude shell preprocessing, nested
command-directory namespaces and private/npm/archive sources remain separate
compatibility gaps. See [Claude skills](https://code.claude.com/docs/en/skills)
and [output styles](https://code.claude.com/docs/en/output-styles).

## Plugin agents

```text
/plugins agents
/plugins agent agent:review.team-tools.inspector
/plugins run-agent agent:review.team-tools.inspector Inspect the changes
/plugins use-agent agent:review.team-tools.inspector
/plugins use-agent off
```

Agents load their complete trusted Markdown body as specialist instructions in the real HIVE agent loop. Explicit plan/review modes retain those instructions and their read-only contracts. The profile is revalidated before provider/tool requests. Tool allow/deny declarations restrict both advertised and executable tools while preserving HIVE's underlying approval, role and path restrictions. Supported aliases include Read, Glob, Grep, Write, Edit, Bash, Skill and LSP, plus exact/glob extension tool names. Argument-scoped allow policies fail explicitly.

Declared `skills` (up to 32 names) preload complete currently trusted/enabled skill bodies and expose their jailed reference-read tool. Bare names prefer the agent's own plugin; `plugin:skill` resolves the original marketplace plugin namespace, and full HIVE skill IDs disambiguate cross-market collisions. Skill content joins the runtime fingerprint and is revalidated before provider/tool requests. Explicit-only skills (`disable-model-invocation: true`) cannot preload automatically; duplicate, ambiguous or unsupported complex policy declarations fail closed. Explicit user invocation remains available. Total agent/preloaded instructions are limited to 64 KiB.

`maxTurns` is bounded to 1–128 and cannot enlarge the caller's turn budget. A declared model remains visible metadata; it cannot replace the user's selected provider/model. Fields such as effort, color, memory, background and isolation remain metadata with warnings. Plugin-agent `hooks`, `mcpServers` and `permissionMode` declarations are accepted but remain inert with explicit warnings, matching Claude's documented plugin-agent security restriction. Unknown fields fail explicitly. Conventional nested `agents/` discovery produces namespaced IDs; declared agent component paths must name Markdown files, as required by Claude's manifest reference.

Selection persists with the TUI conversation and coding session. Clearing the selection applies to the next turn in the same managed workspace. Selecting a new profile on an in-progress resume requires a new turn. HIVE retains its own orchestration, validation and managed-worktree policy.

## Plugin dependencies

Marketplace/native manifests retain dependency requirements and declared plugin versions. Requirements accept `name`, `name@marketplace` and strict `{ "name": "base", "marketplace": "team", "version": "^2.1" }` objects. Bounded common semantic-version ranges include exact/partial/wildcard, caret/tilde, comparisons, AND/OR and hyphen forms, with prerelease rules. Unsupported range syntax fails explicitly.

HIVE resolves already installed bundles only. Requirements must identify an unambiguous, currently trusted/enabled installed plugin with a matching declared version; missing, cyclic, mismatched or revoked dependencies block the dependent bundle and its contributions before execution. `/plugins list` shows the blocking reason. Installation and discovery remain inert, and unrelated bundles remain usable. Dependencies are not fetched, enabled or trusted automatically. This policy also applies to local bundles; it is stricter than Claude's local-version exemption. Updates/revocation are rechecked before subsequent calls.

## LSP

```text
/lsp list
/lsp trust lsp:review.team-tools.typescript
/lsp enable lsp:review.team-tools.typescript
/lsp doctor lsp:review.team-tools.typescript
/lsp hover lsp:review.team-tools.typescript "src/file with spaces.ts" 0 0
/lsp use lsp:review.team-tools.typescript
/lsp use off
```

The stdio client implements Content-Length framing, initialize/shutdown, document open/change, diagnostics, hover, definitions, references, document symbols and workspace symbols. Positions are zero-based UTF-16. Queries read actual current file bytes, stay within the permitted workspace and refresh documents when disk content changes. Errors, cancellation and server crashes are surfaced with bounded startup/request/output lifetimes; reconnect is explicit.

Each connection has a hard 30-minute lifetime, at most 64 open documents and 64 pending requests, a 1 MiB document/message limit and 32 MiB cumulative stdout limit. Bounds fail visibly; lifetime expiration requires an explicit new connection. A long-running coding session does not silently restart the server.

Language servers must already exist. HIVE does not install packages, start socket servers, apply server-proposed edits, run `executeCommand` or silently restart a crashed server. Claude's `transport: "socket"` spelling is accepted with an explicit warning that the process still uses stdio; no actual socket transport is added. Listing/attaching a selected LSP server launches nothing. Agent access starts lazily after the normal tool approval. Plugin-agent selection can expose its own currently trusted/enabled plugin LSP contributions; explicit conversation selection is also supported. Read-only modes retain their existing external-tool restrictions.

## Repair/pause persistence

A real Windows sharing lock on `session.json` reproduced the failed-before-pause symptom with the Fixer already completed. Snapshot and active-pointer publication now retry only transient `EPERM`/`EBUSY` failures, with five backoffs totalling 620 ms, using the same synced temporary file and atomic rename. The identity/metadata guard refuses a changed destination before each retry; unrelated or exhausted failures remain visible. Atomic rename still relies on the cooperative session lease and is not a filesystem compare-and-swap against arbitrary external writers. A detected persistence conflict prevents error-reporting or cleanup from overwriting a foreign checkpoint, while retaining all failure causes.

Actual FileStream lock reproduction now pauses and resumes with one Fixer. Deterministic regressions cover transient recovery, exhausted locks, permanent errors, foreign replacement and simultaneous primary/reporting/cleanup failures. The historical failure lacked detailed error data, so its exact attribution cannot be proved; the reproduced sharing-lock defect is fixed. Evidence: `test-results/repair-pause-diagnosis-final-verification.json`.

## Evidence

The subscription/plugin continuation passed **1,118/1,118** core tests, zero
failures/skips, in 342.5 seconds on 2026-10-17. Final targeted regressions passed
57/57, and lint plus core/desktop-shell/worker builds passed. Independent code,
TypeScript and security review findings were repaired. The unchanged 297-file
core/test/bin snapshot is SHA-256
`58b9df89acc66aa30947968f40875bab23d1595e5d2bf67b0f1dd560a73ce5f9`;
commands, logs, review scope and remaining limits are retained in
`test-results/cli-subscription-plugins-verification.json`.

The owner completed actual ChatGPT device consent. Astra buffered/streaming,
exact-file HIVE tool execution and an independent public CLI planning session
passed; the final subscription client matches the live-check build. Native
Windows ConPTY checked the subscription picker and recorded Node exit 0.
Provider/role defaults remained byte-identical. Earlier fixture/default-shape
and live coding failures remain preserved. A separate read-only dependency audit
reported ten high and eleven moderate baseline advisories with an unchanged
lockfile; dependency remediation was outside this change. No packaging,
publication or deployment was performed.

The task/hook/account continuation passed **1,080/1,080** core tests on 2026-10-17,
with zero failures/skips in 326.8 seconds. Final cancellation/frontdoor regressions
passed 43/43; lint and core/desktop-shell/worker builds passed. Code, TypeScript
and security reviews cleared the integrated repairs. The unchanged final 288-file
source snapshot and command/log hashes are in
`test-results/cli-task-hooks-account-verification.json` (source SHA-256
`3d03de5c7bf2dddf34c1c79919ee82954215aad9bd3a7056c677b04b4a3cbb15`).
Authenticated Gemini 3.5 Flash-Lite discovery, buffered/streaming generation and
actual file-writing separately passed using the owner's existing Windows user
key, without persisting the key or changing provider defaults. See
[account evidence](CLI_PROVIDER_VERIFICATION.md). Preserved earlier failures
include malformed fixture expectations, an obsolete two-local-option picker
assertion and a listed but account-restricted Gemini model. Native terminal
IME/clipboard and packaged Electron acceptance were not rerun.

The modern continuation passed **993/993** core tests on 2026-10-17, with zero failures/skips in 334.0 seconds. Current modern/legacy MCP checks passed 99/99, plugin runtime/parser checks 16/16, persistence/session checks 29/29 and resource-diagnostic fork/desktop files 36/36. Lint and core/desktop-shell/worker builds passed. New regression files are `mcp-lifecycle-2026`, `claude-plugin-compatibility`, `cli-plugin-runtime-compatibility` and `coding-session-persistence` under `tests/`.

The 268-file source snapshot, current commands, exact evidence boundaries and preserved failures are in `test-results/cli-modern-compat-verification.json`. An earlier run exposed invalid legacy-fixture unknown-method dispatch plus a masked malformed-stdio diagnostic; both were repaired. A later run hit real Git ENOMEM/DLL initialization failures at 95% Windows commit usage and an unattributed desktop terminal-status failure. After memory was freed, both affected files passed 36/36 and the final whole suite passed; desktop failure-event diagnostics remain enabled in that test.

Earlier native Windows 80x24/48x24 private-modal proof is reused only for unchanged UI source/dist hashes; it does not claim a new native modern-network journey. The preceding 940-test snapshot is `test-results/cli-final-protocols-verification.json`. Earlier actual Qwen inference, public marketplace installation and OAuth public discovery were not rerun for this revision. Their separate proof boundaries remain in [the parity record](HIVE_CLI_PARITY.md).

References: [MCP transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports), [tasks](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks), [sampling](https://modelcontextprotocol.io/specification/2025-11-25/client/sampling), [elicitation](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation), [Claude hooks](https://code.claude.com/docs/en/hooks), [sub-agents](https://code.claude.com/docs/en/sub-agents), [plugins](https://code.claude.com/docs/en/plugins-reference) and [LSP 3.17](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/).

Current references: [MCP 2026 versioning](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning), [modern HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http), [modern stdio](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio), [discovery](https://modelcontextprotocol.io/specification/2026-07-28/server/discover), [modern tasks](https://tasks.extensions.modelcontextprotocol.io/specification/2026-07-28/tasks) and [Claude dependencies](https://code.claude.com/docs/en/plugins/dependencies).
