# MCP connections and tools


!!! warning "Earlier technical reference"
    This page is retained from earlier documentation and has not been fully revalidated for the public 2026.10.19 release. Its revision-specific links and examples may describe older or development behavior. Start with the [current public-release user guide](../guide/installation.md); do not use this page alone to select installation commands, image tags, or security settings.


BURROW separates a provider connection, its discovered tool catalog and each agent's grants. Saving or discovering a connection does not grant an agent permission to call its tools. PostgreSQL owns these records; mcporter supplies transport.

## Connect, discover, grant

1. Open Settings → Connections → MCP servers and create an enabled connection.
2. Choose `http` with a base URL or `stdio` with a command and arguments. Supply only the credentials/environment the provider needs.
3. Discover the provider's tools. Use Diagnose when startup or connection checks fail.
4. Open the agent's MCP tool settings and grant specific tools from the catalog.
5. Make a test request through that agent and inspect the execution result. Discovery alone is not a successful invocation test.

HTTP API-key credentials become a Bearer authorization header unless an explicit custom `Authorization` header is configured. HTTP-only custom secret headers can be added/replaced/removed in the connection editor; existing values are not returned in metadata reads. A stdio provider runs as a subprocess with the service PATH and configured provider environment values. Use trusted executables and narrowly scoped provider credentials.
```mermaid
flowchart LR
    O[Operator] --> C[Saved connection and encrypted secrets]
    C --> D[Discovered catalog]
    O --> G[Per-agent exact tool grants]
    D --> M[Stable model-facing menu]
    G --> M
    M --> V[Execution validation]
    V --> T[mcporter transport]
    C --> T
    T --> P[HTTP or stdio provider]
    P --> R[Result protection and trace evidence]
```

## The model-facing menu

Three stable native tools expose external capabilities:

| Tool | Purpose |
|---|---|
| `mcp_providers` | List enabled/discovered providers, at most 50 |
| `mcp_capabilities` | Search/page one provider's tools and see grant state |
| `mcp_call` | Invoke an exact provider/tool with arguments |

Provider lookup accepts an exact ID or a unique case-insensitive name. Capability pages default to 12 items and allow at most 20; descriptions are bounded to 2,000 characters. Ungranted tools can appear with `granted: false` so the agent can explain a missing capability. Visibility does not confer permission.

Execution rechecks the connection, exact tool and agent grant. Mod-provided tools additionally require the live mod registration. The runtime includes the menu when its resolved MCP connection map is nonempty. In public **2026.10.19**, `list_skills` and `load_skill` are independent of that MCP menu flag; a connection-free turn can expose the skill tools.
## Connection lifecycle

| Lifecycle | Behavior | Secret-bearing local files |
|---|---|---|
| `ephemeral` | A transient mcporter configuration is created for an operation and removed afterward | Temporary configuration, mode `0600` |
| `keep_alive` | Stable configuration and an idempotently started mcporter daemon | `<mcporterRoot>/runtime/mcp-<id>.json`, mode `0600`, retained while active |

The adapter runtime directory is mode `0700`. Disable/delete or changes affecting provider launch stop the daemon and remove its configuration. Unchanged stable configuration is not rewritten. Encrypted database storage does not mean decrypted credentials never reach disk: the adapter needs a restricted configuration for transport.

Discovery and daemon operations normally have a 20-second deadline; calls have 30 seconds. Timeout sends TERM then KILL after one second. Each stdout/stderr capture retains at most a 256 KiB tail. A parsed provider `isError` response remains a tool error even if mcporter exits nonzero.

The server stores at most 200 sanitized keep-alive lifecycle events in PostgreSQL. At startup it imports an existing `mcp-provider-events.jsonl` once per source path, preserves the full original text in a separate import receipt, and leaves the source file in place. That raw legacy receipt can contain unknown or malformed content and is not guaranteed redacted. Standalone adapter use without the injected store retains the JSONL fallback. Restored state is labeled `lastKnown`; it is not proof that a provider process is currently alive.
## Updating secrets and grants

Secret values are write-only in normal list responses. For connection updates:

- Omitting the entire `environmentVariables` property leaves the saved variable set unchanged
- Supplying the array replaces the set; a retained variable without a new value keeps its stored secret
- Omitting a variable from a supplied replacement array deletes it
- Blank or omitted `apiKey` does not clear the stored API key
- `PUT /api/agents/{agentId}/mcp-tools` replaces the complete grant set

Deleting a connection cascades its stored secrets and grants. The current HTTP handler awaits removal, including keep-alive reconciliation, before returning its result. Re-list connections when a response is lost or an error leaves the result uncertain.
## Protected values

A cooperating provider can declare sensitive leaves with BURROW's typed sensitive-value envelope. The runtime substitutes opaque in-memory handles, binds consumption to the caller and redacts known resolved values from supported output paths. Managed handles additionally check issuer, scope, expiry, provider availability and current authorization.

This is an explicit producer/consumer contract. It does not identify every secret in arbitrary unmarked tool output, and it does not police all shell commands or external-provider behavior. See [permissions](../security/permissions.md) and [trust boundaries](../security/trust-boundaries.md).

## Mod tools use the same grant surface

An enabled server mod can register tools under a provider ID `mod.<mod-id>`. This reuses the MCP catalog and grants without creating a network MCP server. A disabled or failed mod loses live tool availability but retains catalog/grant records; uninstall removes its tool catalog and associated grants. Standalone CLI turns do not automatically host these server mods.

Installed mods are trusted code. A mod's special `mod-authorized` tool availability is accepted only for live mod transport, and its handler must enforce its own record/agent authorization. Read [extension development](../development/extensions.md) before installing or authoring one.

## Image results and activity identity

Current Core persists supported typed MCP image blocks and passes them through native multimodal continuation when the selected model supports vision. It does not decode arbitrary base64-looking text. Invalid or unsupported images produce bounded content errors rather than invented visual evidence. Live and saved activity identifies the underlying provider/tool; `load_skill` activity also retains the selected skill identity. See [operator instructions](../guide/tools-and-mods.md#http-mcp-headers-and-returned-images).

## Diagnose a connection

Check the enabled state, transport settings, saved secret indicators, discovered catalog and exact agent grants in that order. Then use Diagnose and inspect its bounded classification. For stdio failures, verify the executable exists in the service environment, not only your interactive shell. For `keep_alive`, distinguish historical receipts from present liveness.

The API endpoints are listed in [settings and integrations](../reference/api/settings.md); installation paths are in the [environment reference](../reference/environment.md#mcp-provider-login-and-mods).



## Targeted source review

Corrections on this page were checked against public **2026.10.19**; any newer development behavior is labeled separately. This was static source inspection, not a live deployment test. Other retained details remain subject to the earlier-reference warning.

- [backend/scripts/ui/settings-routes.mjs](https://github.com/GoblinKing-Burrow/Burrow/blob/aa5a30da683a3a8ea919025f107ff53f182ef8d6/backend/scripts/ui/settings-routes.mjs)
- [backend/src/action-proposal.mjs](https://github.com/GoblinKing-Burrow/Burrow/blob/aa5a30da683a3a8ea919025f107ff53f182ef8d6/backend/src/action-proposal.mjs)
