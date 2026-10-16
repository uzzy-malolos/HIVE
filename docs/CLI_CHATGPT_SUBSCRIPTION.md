# ChatGPT subscription sign-in

HIVE can use an installed **Codex app-server** as a subscription-backed provider.
Codex owns browser/device sign-in, refresh and OS-keyring credentials. HIVE uses
the supported account and thread APIs; it never extracts another client's tokens
or calls a private inference endpoint with borrowed credentials.

From a source checkout, replace `hive` with `node ./bin/hive.mjs`:

```text
hive providers add --id chatgpt --preset chatgpt
hive providers login chatgpt --device
hive providers auth-status chatgpt
hive providers models chatgpt
hive providers approve chatgpt
hive --model chatgpt/YOUR_SELECTED_MODEL
```

`login` without `--device` prints the browser authorization URL. Complete consent
on OpenAI's page; HIVE does not open or approve it automatically. The terminal
operation is cancellable. Sign-in times out after three minutes in the command
frontdoor; retry explicitly if its code expires. `/connect subscription` offers
the same registration in the TUI, and `/providers login chatgpt --device` displays
the authorization instructions. The terminal setup wizard also offers a third,
subscription option.

Registration stays unapproved until explicitly approved. It does not invent a
model or replace role defaults. Inspect the current model list, then select the
exact model. Model catalogs are not account-entitlement proof; a successful turn
establishes access to that model for that request. `auth-status` reports sign-in
and plan type without exposing email, account IDs or credentials.

```text
hive providers logout chatgpt
```

This signs out HIVE's account only. All HIVE subscription providers use the same
HIVE-owned Codex account home, `~/.hive/chatgpt`. Existing Codex app/CLI accounts
and their configuration remain separate. Credentials use Codex's supported
`keyring` storage; unavailable secure storage fails instead of falling back to a
plaintext token file. HIVE does not install Codex or edit its global settings.

The account home is for auth/runtime state. Nonempty custom `config.toml` and
custom extensions there are refused, so they cannot add hidden MCP servers,
hooks or capabilities. Configure HIVE extensions through HIVE. Bundled Codex
skill instructions are explicitly disabled, and provider threads must report
no ambient instruction files.

Each completion uses an ephemeral thread in an empty disposable directory with
read-only, network-disabled tool sandbox and approval policy `never`. Shell,
apps, MCP configuration, image generation and other optional native capabilities
are disabled. Unexpected tool requests/events reject the completion; native
patch writes are also rejected by Codex's pre-execution safety policy. This is
not a promise that every model's tool metadata is empty. HIVE structured
`toolCalls` JSON remains text until HIVE separately validates and executes it.
Selected model identity is checked, provider fallback is disabled in this
adapter, and effort/service-tier fields are left unchanged by the adapter.

The installed protocol **does not expose a request output-token cap**. HIVE
refuses explicit `maxOutputTokens` requests rather than discarding that limit.
Consequently the strict `providers verify` probe, MCP sampling and verifier hooks
that require a token cap cannot use this provider. Choose a capped API/local
provider for those operations. Ordinary coding turns retain HIVE's turn/tool
budgets, cancellation, five-minute completion deadline and bounded output.

Supported protocol behavior was checked against Codex
`0.163.0-alpha.10.2`; unsupported versions fail visibly. Real subprocess fixtures
cover login/cancellation, startup interruption, model mapping, tool denial,
credential isolation, event correlation and bounded output. Live-account proof
is recorded separately in [provider verification](CLI_PROVIDER_VERIFICATION.md).

References: [Codex app-server](https://learn.chatgpt.com/docs/app-server),
[Codex authentication/storage](https://learn.chatgpt.com/docs/auth).
Direct OAuth for a separate HIVE inference client remains a different integration
requiring the appropriate registered client; it is not needed for this explicit
Codex-managed route.
