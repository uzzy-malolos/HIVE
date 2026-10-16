# MCP HTTP OAuth

HIVE supports an explicit authorization-code login for trusted, enabled HTTP MCP servers. It discovers protected-resource metadata and authorization-server metadata, binds the grant to the configured MCP resource, and uses S256 PKCE, a cryptographically random state value, and a loopback listener bound only to `127.0.0.1`. Login never calls a tool or opens a browser automatically.

Use `/mcp login SERVER` (or `hive mcp login SERVER`), open the printed authorization URL, review the provider's consent screen, and return to HIVE. The callback path is `/oauth/callback`. Authorization expires after 120 seconds and can be cancelled. `/mcp auth-status SERVER` reports authentication and expiry without revealing credentials. `/mcp logout SERVER` removes the local encrypted grant. Provider-side consent/revocation remains managed by the provider; local logout does not claim to revoke it remotely.

Servers with dynamic client registration can issue a public client automatically. Otherwise, register a HIVE OAuth client with the provider and add its client ID to `.hive/extensions.json`:

```json
{
  "version": 1,
  "mcpServers": {
    "example": {
      "transport": "http",
      "url": "https://mcp.example.com/mcp",
      "oauth": {
        "clientId": "registered-client-id",
        "redirectPort": 8765
      }
    }
  }
}
```

Register `http://127.0.0.1:8765/oauth/callback` for that fixed-port example. Without `redirectPort`, HIVE binds an available ephemeral port, appropriate for native clients whose authorization server permits varying loopback ports. Public clients need a token authentication method of `none`; configured confidential clients can reference an explicit `clientSecretEnv` and use `client_secret_basic` or `client_secret_post`. Secret values never belong in repository configuration. Existing `bearerTokenEnv` authentication is preserved and cannot be combined with OAuth configuration.

OAuth endpoints require HTTPS and public network destinations. HIVE checks every DNS answer for private/reserved addresses and connects directly to a checked numeric IP while preserving the original HTTP authority, TLS server name, and certificate verification. It disables connection-pool reuse and redirect following. An embedding host can explicitly enable literal-loopback HTTP through `allowLoopbackOAuthHttp` or private HTTPS infrastructure through `allowPrivateOAuthHosts`; repository configuration cannot enable these exceptions. HIVE follows the protected-resource `WWW-Authenticate` metadata URL first, then path-specific and root well-known URLs. Authorization-server discovery supports OAuth metadata and the OIDC path variants. The requested resource must match the configured server; the issuer must match discovered metadata. Challenge scopes take priority, followed by configured scopes and advertised resource scopes.

Tokens are saved outside the repository in `~/.hive/mcp-oauth` as encrypted records. The Windows CLI uses current-user DPAPI through the system PowerShell executable, with secrets passed over stdin rather than command arguments. It refuses plaintext persistence. Other operating systems currently need an embedding host to provide an OS-backed `OAuthCipher`; login fails clearly when secure encryption is unavailable. Tests inject an isolated authenticated cipher and temporary storage. No credentials, cookies, or sessions are imported from other coding clients.

Every HTTP request carries the resource's bearer token. Expiring tokens refresh before the request; refresh-token rotation is persisted under a cooperative per-record lock. A rejected initialization or tool-list request may refresh and retry once. A `tools/call` request is never automatically replayed after an authorization failure. Its error directs the user to authorize again, and a subsequent explicit operation can refresh the rejected token. Tokens echoed by an MCP server are redacted from responses and errors.

Grants are bound to the canonical workspace, namespaced server ID, resource URL, and trusted configuration fingerprint. Editing a server configuration invalidates its previous grant until a new login replaces it. A malformed or undecryptable grant fails closed; local logout can remove the encrypted record without decrypting it. Logout also writes a durable, non-secret generation tombstone, so an authorization opened in another process cannot republish a token after logout. Cancelling login aborts the token exchange as well as the callback listener; cancellation and generation are rechecked under the storage lock before publication. Storage rejects symlink directories, symlink/hard-linked credential files, oversized records, and non-private POSIX permissions.

Current boundaries: one advertised authorization server per protected resource; no hosted Client ID Metadata Document, device-code flow, client-credentials flow, automatic browser launch, remote token revocation, or OS credential-store implementation for macOS/Linux. OAuth login requires an MCP server implementing protected-resource metadata, discoverable authorization metadata, and advertised S256 PKCE. This is MCP authorization, not a claim of access to another product's account or subscription.

## Live public discovery

On 2026-10-16, production HIVE discovery reached Notion's documented public
`https://mcp.notion.com/mcp` endpoint from an isolated temporary workspace. It
validated the protected resource and issuer metadata and constructed a
resource-bound S256 PKCE authorization URL with a loopback callback. The probe
used an unregistered placeholder client ID and cancelled immediately; it did
not register a client, open consent, exchange tokens or call tools. Authentication
remained false after cancellation. This proves live public metadata/transport
compatibility, not account authorization. Evidence:
`test-results/cli-oauth-public-discovery-2026-10-16.json`.

Sources: [MCP authorization specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization), [MCP SSRF defenses](https://modelcontextprotocol.io/docs/2025-11-25/tutorials/security/security_best_practices), [RFC 8252 native application loopback redirects](https://www.rfc-editor.org/rfc/rfc8252.html#section-7.3), [OAuth security best current practice](https://www.rfc-editor.org/rfc/rfc9700.html), [Notion's documented MCP endpoint](https://developers.notion.com/guides/mcp/get-started-with-mcp).
