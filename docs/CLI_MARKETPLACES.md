# Marketplace plugins

HIVE can browse and install public plugin marketplaces and local development marketplaces. Adding or updating a marketplace reads its catalog and snapshots its files. Installing a plugin copies a pinned bundle into the workspace; it never runs install scripts, installs dependencies, invokes a package manager, or grants trust.

```text
/plugins marketplace add anthropics/claude-plugins-official
/plugins marketplace add https://git.example.com/team/plugins.git
/plugins marketplace add https://plugins.example.com/marketplace.json
/plugins marketplace add "C:\\team\\plugin-marketplace"
/plugins marketplace list
/plugins marketplace list team-tools
/plugins install review@team-tools
/plugins update review@team-tools
/plugins marketplace update team-tools
/plugins marketplace remove team-tools
```

Use the marketplace's `name` from `marketplace.json`, rather than its GitHub repository name, in selectors. Installed registrations use `plugin:<plugin>.<marketplace>`; skill and MCP IDs include that name. For example, `review@team-tools` produces `plugin:review.team-tools`, and the imported `check` skill is `skill:review.team-tools.check`.

Inspect the copied files and `hive.marketplace.json`, then explicitly trust and enable the registration:

```text
/plugins trust review.team-tools
/plugins enable review.team-tools
```

`/plugins uninstall review.team-tools` unregisters the plugin and revokes trust. Its copied source files remain available. Removing a marketplace preserves installed plugins and retained snapshots. Updating a marketplace changes only its catalog snapshot. Updating a plugin copies the current catalog's selected source to a new directory, replaces only its expected registration, disables it and revokes previous trust. Previous bundle directories and displaced registry/configuration files remain available for recovery.

## Source compatibility

The catalog uses Claude's `.claude-plugin/marketplace.json` layout, with `name`, `owner` metadata and a `plugins` array. A root `marketplace.json` is also accepted. Each entry requires `name` and `source`. Invalid entries produce individual diagnostics, so one unsupported entry does not hide the rest of the catalog.

Supported marketplace locations are a local directory or `marketplace.json`, a public HTTPS Git repository, an `owner/repository` GitHub shorthand, and an HTTPS URL pointing directly to JSON. Git refs/commit pins can also be supplied through the public `addMarketplace` API as `{ kind: "git", url, ref?, sha? }`. CLI URLs default to the repository's default branch. HTTPS JSON catalogs contain only their downloaded manifest, so their plugin entries must reference external Git repositories.

Supported plugin sources are:

| Source | Example |
| --- | --- |
| Relative bundle | `"./plugins/review"` |
| Root bundle | `"."` |
| Name beneath `metadata.pluginRoot` | `"review"` with `"pluginRoot": "./plugins"` |
| GitHub repository | `{ "source": "github", "repo": "team/review", "ref": "v1", "sha": "<40 lowercase hex characters>" }` |
| Public Git repository | `{ "source": "url", "url": "https://git.example.com/review.git" }` |
| Git subdirectory | `{ "source": "git-subdir", "url": "team/monorepo", "path": "tools/review", "ref": "v1" }` |

A Git commit pin takes precedence over a ref. HIVE fetches Git objects into an isolated bare repository and reads regular blobs directly. It never checks out untrusted content, runs repository hooks or filters, initializes submodules, fetches LFS objects, or inherits Git credentials/configuration. Adding a Git marketplace snapshots only its manifest. Installing a relative bundle fetches only its selected file subtree at the catalog's recorded commit, so unrelated plugins cannot block it or consume its extracted-file budget. The underlying shallow Git object download is still bounded at 64 MiB; partial clone filtering is not enabled.

`npm`, `archive`, `command`, SSH and authenticated/private Git sources are not supported. Entries using unsupported source types remain visible with an explicit reason and fail installation. HIVE does not silently convert them into shell commands.

## Bundle compatibility

Native `hive.plugin.json` bundles support MCP, skills, hooks, agent Markdown paths and stdio LSP declarations. The installer adjusts their registration name to include the marketplace namespace.

Claude bundles may provide `.claude-plugin/plugin.json`, or use the marketplace entry as their manifest. The importer generates an inspectable `hive.plugin.json` beside the original files and supports:

- Conventional `skills/<name>/SKILL.md`, declared directory paths with optional trailing slash, direct directories containing `SKILL.md` and plugin-root skills. Root-source shared marketplaces respect their declared skill paths.
- Conventional `commands/*.md`, declared command paths, and command maps with exactly one of `content` or Markdown `source`. Declared paths replace the default commands scan. Commands become user-invocable HIVE skills; their prompt body and original source/reference directory are retained.
- `.mcp.json`, JSON configuration paths, inline stdio/Streamable HTTP maps and arrays mixing those forms. Default configuration loads first; later server definitions override earlier definitions by name. Explicit `type`/`transport` must agree and HTTP/process fields cannot be mixed. Binary `.mcpb`/`.dxt` bundles remain unsupported.
- `${CLAUDE_PLUGIN_ROOT}` is expanded deterministically in installed Markdown and stdio command/args/settings, and exported to the imported server process. Process settings may use bounded non-secret literals or `${ENV_NAME}` references. Credential names, recognizable secrets and credential-bearing URL literals require references. HTTP authentication headers remain `Authorization: Bearer ${ENV_NAME}`. HIVE retains those references rather than copying environment values.
- Marketplace component additions under Claude's documented `strict` rules. `strict:false` plus competing component declarations fails explicitly.
- Hooks from conventional `hooks/hooks.json`, declared JSON paths and inline groups support command, HTTP, prompt, agent and MCP tool handlers. Eleven mapped events include session/prompt/tool boundaries, Stop/StopFailure, SubagentStart/Stop and PermissionRequest. Direct executable/args and explicitly supported Bash/PowerShell command strings are translated; bounded matcher, context, block, stop and continuation semantics are enforced. Model and MCP handlers retain explicit host approval. Failure callbacks preserve actual error/duration; successful Claude post-tool hooks do not run after failure. Unsupported event/type combinations and output directives fail explicitly.
- Agent Markdown from declared `.md` files or recursive conventional `agents/` discovery, including nested namespaces, specialist instructions, supported tool allow/deny aliases, trusted skill preloads and `maxTurns`. Declared directory paths are unsupported as in Claude's official manifest contract. Agent selection preserves the user's HIVE provider/model, modes, approval and workspace rules. Plugin-agent private hooks/MCP/permission declarations remain inert with warnings, matching Claude's documented security restriction.
- Inline/path-based `.lsp.json` stdio server declarations, extension-to-language maps, startup settings and referenced environment credentials. Installation never downloads a language server. A trusted explicit query or approved selected agent tool starts the existing executable.
- Plugin dependency requirements and declared plugin versions, including bounded semantic-version ranges. Installed dependencies must satisfy the namespace/version and current trust/enable requirements; unresolved bundles remain inspectable and blocked before execution. No dependency is fetched, installed, enabled or trusted automatically. See [dependency policy and skill preloads](CLI_PROTOCOLS.md).
- Output-style Markdown from default or declared paths, with explicit trusted selection, persistent namespaced identity and actual Queen final-response synthesis. HIVE keeps engineering/permission rules and does not auto-select `force-for-plugin` styles. User-invocable command policies and argument hints are preserved; literal positional argument expansion occurs only on explicit invocation.

Compatible hooks include command, HTTP, prompt, agent and MCP tool handlers on HIVE's eleven mapped lifecycle boundaries, with event/type validation, current trust and explicit host approvals. Workflows, channels, user configuration, asynchronous hook services and unlisted lifecycle events are not translated. Actual LSP transport remains stdio; Claude's `socket` spelling is accepted with an explicit stdio warning. A bundle requiring other unsupported components fails installation with the component name. No unsupported executable component is silently enabled or dropped. The [advanced protocol guide](CLI_PROTOCOLS.md) documents exact hook, style, argument, agent and LSP runtime behavior and remaining limits.

The importer does not claim complete Claude runtime compatibility. Imported
command/skill metadata governing model/tool routing and shell preprocessing
produces explicit warnings; it does not change HIVE providers or permissions or
run shell substitutions. Positional arguments expand as literal text on explicit
invocation; named argument declarations fail visibly. HIVE permissions and explicit extension
trust govern execution. Imported command hooks support `CLAUDE_PROJECT_DIR` at
runtime. Claude data-directory/user-config interpolation, and project-directory
interpolation in non-hook Markdown/MCP/LSP contributions, remain unsupported.

Selected trusted plugin skills/commands can read Markdown/text references within
their own package using `read_skill_reference` with explicit `scope: "plugin"`.
Original command source context identifies the correct relative base, while
interpolated installed-root paths are accepted only inside that same plugin.
Default skill scope stays jailed to its own directory; private paths, escapes,
hardlinks, oversized files and changed trust remain blocked.

## Bounds and provenance

Each registered catalog records its manifest SHA-256, complete snapshot SHA-256, resolved Git commit when applicable, source and update time. Each plugin contains `hive.marketplace.json` with its selector, catalog manifest hash, selected entry hash, original and imported bundle tree hashes and resolved commit. Installations use the saved catalog snapshot; upstream changes do not affect an installed bundle until explicitly updated. A modified cached snapshot fails its integrity check. Discovery also verifies managed plugin source files against their imported tree hash, excluding the provenance file itself. Changing that provenance requires fresh trust even if its expected hash was recalculated. Native manually registered plugins retain their existing manifest and skill-content trust semantics.

Storage is workspace-local under `.hive/marketplaces/` and `.hive/plugins/`. Runtime trust stays outside the repository through the normal extension trust store. Local source snapshots exclude `.git`, `.hive` and `.hivemind` directories. File publication and configuration registration use cooperative locks, exclusive publication and retained displaced files. Conflicting writers are reported; stale locks require inspection.

Limits are 32 marketplaces, 512 catalog entries, 2,048 files per snapshot, 4 MiB per regular file and 32 MiB per extracted snapshot. A JSON-only download is limited to 512 KiB and an absolute 30-second deadline spanning DNS through the response body. A Git subprocess is limited to 60 seconds, with a 64 MiB storage monitor during fetch and a final awaited size check before any snapshot is accepted. Fetch monitoring can briefly overshoot between checks; it is not an exact server-side transfer quota. Git blob reads enforce the extracted limits before copying.

Public remote sources require credential-free HTTPS URLs without query strings, fragments or redirects. DNS results must be public, and requests pin a validated address while retaining TLS hostname verification. Symlinks, hardlinks, submodules, special files, Windows reserved names, alternate data streams, traversal, case-colliding paths, known credential files and recognizable private keys/tokens fail the snapshot. These checks reduce accidental credential copying; they do not certify third-party code. Local source files and copied bundles remain unexecuted until a separate, explicit trusted operation.

Compatibility references checked against the official [Claude marketplace reference](https://code.claude.com/docs/en/plugins/marketplace-reference) and [plugin manifest reference](https://code.claude.com/docs/en/plugins-reference).

## Verification

On 2026-10-16, an isolated temporary workspace downloaded the real official marketplace at commit `ea10b213686c90bb1984b2016937310e05336cf3`, parsed all 315 entries without diagnostics, and installed `commit-commands@claude-plugins-official`. The resulting catalog contained the imported `clean_gone`, `commit-push-pr` and `commit` commands, all disabled and untrusted. No plugin code ran and no user workspace registry or trust state changed. `test-results/cli-marketplace-live-install.json` records catalog, original/imported bundle and source hashes. This establishes live download, commit pinning, conversion, installation and inert discovery; plugin command execution was not exercised.

The focused local suite passed 13 marketplace tests plus 16 OAuth tests after the final network and scoped-fetch changes. Tests cover actual Git fixtures, HTTP downloads, source drift, source limits, cancellation, private/reserved addresses, pinned transport options, portable path collisions and the existing OAuth runtime.

The advanced compatibility continuation added real local Git/stdio regressions
for root/directory skills, source/inline command maps, source-base reference
access, mixed MCP configuration forms and ordered overrides, exported plugin
roots, literal settings and referenced credentials. Imports remain inert until
separate trust/enable; managed bundle drift is rejected. This local fixture
evidence is separate from the earlier public-marketplace installation above.

The 2026-10-17 continuation verified a real local marketplace bundle containing
command hooks, an agent and an LSP server through actual CLI/TUI/Queen processes.
It remained inert until trust/enable; real LSP navigation handled a filename with
spaces, specialist instructions reached the selected model in auto/plan/review,
tool restrictions blocked attempted writes and clearing a selection survived a
follow-up. The final core suite passed 940/940; exact supported forms and limits
are in [CLI_PROTOCOLS.md](CLI_PROTOCOLS.md). Current source and earlier failed
runs are qualified in `test-results/cli-final-protocols-verification.json`.
The earlier public marketplace installation was not rerun for this revision.

The broader compatibility pass added installed dependency/version requirements,
trusted skill preloads (including original marketplace namespaces and
explicit-only policy guards), documented inert plugin-agent fields and actual
failure-hook routing. Plugin runtime/parser checks passed 16/16, and the final
integrated core suite passed 993/993 with lint and shared builds. Source snapshot:
`test-results/cli-modern-compat-verification.json`. Dependency fetching and other
unsupported executable forms remain outside this scope; see
[CLI_PROTOCOLS.md](CLI_PROTOCOLS.md).
