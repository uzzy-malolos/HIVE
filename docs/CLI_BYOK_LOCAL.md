# BYOK and local models

HIVE CLI supports your own provider API key and local model servers. Use
`hive providers setup` in a terminal, or `/connect` inside HIVE. Both offer:

- **BYOK:** OpenAI, Anthropic, Google Gemini, OpenRouter, OpenCode Console,
  Kilo Gateway, Cline API, a custom
  OpenAI-compatible API, or your configured HIVE Cloud endpoint.
- **Local:** Ollama, the owner-started Hermes subscription proxy, or an OpenAI-compatible server such as LM Studio,
  llama.cpp or vLLM. No API key is required for a keyless local server.
- **Subscription:** ChatGPT sign-in through an installed Codex app-server, with
  a separate HIVE account home and OS keyring. See [setup and limits](CLI_CHATGPT_SUBSCRIPTION.md).

From a source checkout, run `node ./bin/hive.mjs providers setup` instead of
`hive providers setup`; the same substitution applies to the commands below.

Setup stores the provider endpoint, actual model ID and key **environment-variable
name** in `.hive/providers.json`. It never asks for or saves the key value.
Set the referenced variable in your secure environment before launching HIVE;
restart HIVE after changing its environment. A missing selected variable fails
clearly, without silently using a different account's key.
The coding router also captures the selected key privately before health and
generation, masking raw and common encoded echoes in responses and errors.
Streaming withholds incomplete key matches before publishing chunks; captured
values stay local to the request and are never added to saved session metadata.

## Terminal wizard

```text
hive providers setup
```

Choose BYOK or local, then the provider, ID, base URL and actual model ID.
The wizard checks its health prerequisite and approves a successful setup.
It then prints an explicit `hive --model PROVIDER/MODEL` command.
An additional **default No** question offers to replace the default coding-role
assignments. Existing roles remain unchanged unless you explicitly answer yes.

Use a model ID offered by your provider or loaded in your local runtime. HIVE
does not invent a default model, install/start a runtime, pull weights or
substitute a different model. For local use, start your runtime and load a model
first. Default local endpoints are `http://127.0.0.1:11434` for Ollama and
`http://127.0.0.1:1234/v1` for local OpenAI-compatible servers; change the port
to match your runtime. HTTPS endpoints and loopback HTTP, including `localhost`
and `[::1]`, are accepted. Remote plaintext HTTP is rejected.

Health checking does not prove generation or model quality. In particular,
Anthropic and Google health currently check key presence. Run explicit
[provider verification](CLI_PROVIDER_VERIFICATION.md) to exercise generation.

## Requested gateway and subscription choices

| Choice | HIVE preset / credential reference | Supported route |
|---|---|---|
| Gemini API | `google` / `GEMINI_API_KEY` | Native Gemini API |
| Claude API | `anthropic` / `ANTHROPIC_API_KEY` | Native Messages API |
| OpenCode Console | `opencode` / `OPENCODE_API_KEY` | Chat Completions models at `https://opencode.ai/inference/openai/v1` |
| Kilo Gateway | `kilo` / `KILO_API_KEY` | `https://ai-gateway.kilo.ai/api/v1` |
| Cline API | `cline` / `CLINE_API_KEY` | `https://api.cline.bot/api/v1` |
| Hermes / Nous | `hermes` / local proxy | `http://127.0.0.1:8645/v1`; Hermes owns account sign-in and refresh |
| ChatGPT subscription | `chatgpt` / Codex-managed sign-in | Isolated HIVE account, supported app-server API, explicit browser/device consent; no token import |

HIVE does not read other clients' tokens or launch/install their proxies. Start the
documented Hermes proxy yourself and choose the model it exposes. OpenCode's
shared catalog is `/inference/v1/models`; catalog and health use that route.
Its catalog also contains models requiring Responses, Anthropic or Google
protocols, which this Chat Completions preset cannot invoke. Choose a compatible
model from the current provider documentation, then run bounded verification.

References: [OpenCode protocols](https://opencode.ai/v2/docs/console/models/),
[Kilo authentication](https://kilo.ai/docs/gateway/authentication),
[Cline API authentication](https://docs.cline.bot/api/authentication),
[Hermes proxy](https://hermes-agent.nousresearch.com/docs/user-guide/features/subscription-proxy),
[ChatGPT client registration](https://developers.openai.com/siwc/request-client-id).
Anonymous catalog access proves reachability; it does not prove account access,
model entitlement or authenticated inference.

## Configure inside HIVE

`/connect` opens the BYOK/local picker; `/connect byok` or `/connect local` goes
directly to its provider choices. Selecting a provider inserts an editable
registration command. Enter its actual model ID. Custom API and HIVE Cloud
templates also require replacing `<endpoint>` with your API base URL.

The same registration, inspection and approval commands work in the terminal:

```text
/providers add --id personal --preset openai --model MODEL_ID --api-key-env MY_OPENAI_KEY
/providers test personal
/providers approve personal
/model personal/MODEL_ID
```

Replace `MODEL_ID` with the actual model ID and `MY_OPENAI_KEY` with the
environment-variable name you use. Enter no key value in these commands.
Registration stays unapproved until you explicitly approve it. `/model` selects
an approved provider for this conversation and persists that choice for restart
and follow-up turns, without rewriting role defaults. The model picker also has
BYOK/local setup entries when no models are configured.

## Headless or manual setup

The wizard requires a terminal. Scripts use the same named presets:

```text
hive providers presets --json
hive providers add --id local-models --preset local --base-url http://127.0.0.1:1234/v1 --model MODEL_ID
hive providers test local-models
hive providers approve local-models
hive -p "Inspect this project" --model local-models/MODEL_ID --json
```

Use `--preset ollama` for an Ollama server. Its adapter sends no authentication;
authenticated OpenAI-compatible servers can use an explicit `--api-key-env`.
The previous `--kind` registration syntax remains available, including
model-less registration followed by explicit model/role selection.

Provider configuration uses the canonical Git repository root even when setup
starts from a subdirectory. Existing global providers remain available; project
registrations shadow matching global IDs, including unapproved project rows.
Listing labels the scope. Testing, discovery, selection and verification resolve
the same provider catalog. New registrations are project-local.

## Discover actual models

```text
hive providers models local-models --json
/providers models local-models
```

These are explicit, read-only GET requests to `/api/tags` for Ollama, `/models`
for OpenAI-compatible endpoints, or the native Anthropic/Google models API.
There is no generation or model download. An approved provider's returned models
become selectable inside the terminal. No model list is fetched automatically
just to open a menu. Missing keys, offline servers, invalid responses and
cancellation are surfaced; no fabricated fallback models are returned.

Discovery is bounded to 8 MiB across at most 16 pages and 4,096 unique model
IDs, with an absolute 15-second deadline. Native API pages request at most 512
entries. Redirects are rejected and authentication uses only the configured
environment reference. Native adapters accept only their supported official
endpoint; use a custom compatible provider for a compatible proxy.

## Verification evidence

The local tests cover no-key server setup, explicit BYOK references, Google
credential binding, cancellation, safe listings, global/project scope and
subdirectory setup. Real CLI child processes register/test/approve a local
provider through these commands, then code, restart, follow up and fork without
pre-seeded role assignments. Native Windows terminal checks cover the picker,
editable registration, health/approval, real fixture model discovery, model
selection and persisted restart.

Public OpenRouter catalog discovery passed against its actual API with 465
models and 779,384 response bytes. Evidence:
`test-results/cli-byok-openrouter-catalog-v2.json`. This was a credential-free
catalog read, not authenticated inference.

Actual local inference also passed health, buffered generation, 11 streamed
chunks and an exact-byte file-write tool workflow with an isolated portable
llama.cpp runtime and Qwen2.5-Coder-1.5B-Instruct. Existing provider/role defaults
were unchanged; the temporary server stopped and its large model file was
removed. Evidence and retained first-attempt failure:
[CLI_PROVIDER_VERIFICATION.md](CLI_PROVIDER_VERIFICATION.md). This proves the
tested local integration; external BYOK authentication and broader model quality
remain separate checks. Start your chosen local runtime or supply your own
environment credential when setting up your everyday sessions.
