# Environment variables

This reference separates supported service settings from installer, test and compatibility names. Defaults below describe the pinned source. Installation scripts and containers can override them; inspect the actual service environment before diagnosing a mismatch. Never paste encryption keys, database passwords or provider credentials into a diagnostic report.

See [configuration ownership](configuration.md), [deployment](../operations/deployment.md) and [containers](../operations/containers.md).

## Listener and authentication

Authentication settings resolve as explicit runtime arguments → environment → PostgreSQL settings → defaults. Comma-separated values are trimmed. An environment override can keep a database/UI change from becoming effective.

| Variable | Default / interpretation |
|---|---|
| `BURROW_UI_HOST` | Direct server/Docker `0.0.0.0`; native installer writes `127.0.0.1`; generic config resolver `127.0.0.1` |
| `BURROW_UI_PORT` | `42817`; direct server also accepts `--port=`, after the environment |
| `BURROW_UI_AUTH_MODE` | Persisted value, otherwise `none`; choices `none`, `trusted-proxy`, `basic`, `oidc` |
| `BURROW_UI_AUTH_ALLOWED_PROXIES` | `127.0.0.1,::1`; exact socket peer addresses, not CIDRs |
| `BURROW_UI_AUTH_USER_HEADER` | `x-forwarded-user`, normalized to lowercase |
| `BURROW_UI_AUTH_BASIC_USERNAME` | Unset; required for Basic mode |
| `BURROW_UI_AUTH_BASIC_PASSWORD_HASH` | Unset; stored scrypt hash, not a plaintext password |
| `BURROW_UI_AUTH_BASIC_SESSION_TTL_SECONDS` | `43200`; minimum 60 seconds |
| `BURROW_UI_AUTH_OIDC_ISSUER` | Unset; required for OIDC |
| `BURROW_UI_AUTH_OIDC_CLIENT_ID` | Unset; required for OIDC |
| `BURROW_UI_AUTH_OIDC_CLIENT_SECRET` | Unset; alternatively encrypted PostgreSQL secret |
| `BURROW_UI_AUTH_OIDC_REDIRECT_URI` | Unset; configure the provider callback deliberately |
| `BURROW_UI_AUTH_OIDC_SCOPES` | `openid,email,profile` |
| `BURROW_UI_AUTH_OIDC_ALLOWED_EMAILS` | Empty; optional comma-separated allowlist |
| `BURROW_UI_AUTH_OIDC_ALLOWED_DOMAINS` | Empty; optional comma-separated allowlist |
| `BURROW_UI_AUTH_OIDC_INSECURE_COOKIES` | Only literal `true` disables OIDC Secure cookies; local development only |

[Resolver](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/config.mjs#L160-L197) · [Actual listener](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/scripts/burrow-ui.mjs#L114-L120) · [Authentication caveats](../security/authentication.md)

## Runtime paths and key material

| Variable | Default / purpose |
|---|---|
| `BURROW_RUNTIME_ROOT` | Generic `/mnt/local/burrow`; native installer `$HOME/.burrow`; Docker `/data` |
| `BURROW_SOURCE_ROOT` | Loaded release/source root; generic resolver can fall back to current directory |
| `BURROW_WORKSPACE_ROOT` | `<runtimeRoot>/workspace` |
| `BURROW_AGENT_ID` | Resolver fallback `hatchet`; does not create that agent |
| `BURROW_AGENT_WORKSPACE_ROOT` | `<workspaceRoot>/<agentId>`; suppressed by an explicit workspace-root argument |
| `BURROW_SKILLS_ROOT` | `<agentWorkspaceRoot>/skills`; current managed skill catalog also has PostgreSQL authority |
| `BURROW_CACHE_ROOT` | `<runtimeRoot>/cache` |
| `BURROW_ARCHIVE_ROOT` | `<runtimeRoot>/archive` |
| `BURROW_SETTINGS_KEY` | Required external key material: Base64 encoding of exactly 32 bytes |
| `BURROW_SETTINGS_KEY_FILE` | Container-entrypoint override; defaults to `<runtimeRoot>/config/settings.key` |
| `BURROW_SHUTDOWN_DRAIN_MS` | `10000`; minimum 1000 ms HTTP connection drain window |
| `BURROW_DISABLE_BACKGROUND_SCHEDULERS` | Disabled only when set to `1`, `true`, `yes` or `on`, case-insensitive |
| `BURROW_BOOTSTRAP_SAMPLE_IDENTITIES` | Sample-identity bootstrap is opt-in; use `1` for explicit fixtures, not as ordinary setup |

The encryption key is needed to decrypt stored credentials after recovery. Keep it with a protected backup, outside public documentation and source control. Container startup persists a generated key and rejects a conflicting supplied key. The key-file variable is an entrypoint feature, not a general backend file-loader setting.

[Paths](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/config.mjs#L200-L228) · [Key loader](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/mcp-settings-store.mjs#L10-L16) · [Container key persistence](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/docker-entrypoint.sh#L1-L33) · [Schedulers](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/background-scheduler-policy.mjs#L1-L3) · [Shutdown](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/scripts/burrow-ui.mjs#L3290-L3305)

## PostgreSQL

The supported startup wrapper requires an explicit lifecycle. Although the low-level resolver defaults to `disabled`, normal startup rejects it with `postgres_startup_requires_explicit_lifecycle`. The native installer and container select `managed` unless configured otherwise.

| Variable | Default / purpose |
|---|---|
| `BURROW_POSTGRES_LIFECYCLE` | `managed` or `external` for startup; wins over compatibility `BURROW_POSTGRES_MODE` |
| `BURROW_POSTGRES_MAJOR` | Expected server major `17` |
| `BURROW_POSTGRES_URL` | Connection URL; takes precedence over `DATABASE_URL` and individual fields |
| `DATABASE_URL` | Fallback external connection URL |
| `BURROW_POSTGRES_HOST` | `127.0.0.1` in general pool configuration |
| `BURROW_POSTGRES_PORT` | `5432` |
| `BURROW_POSTGRES_DATABASE` | `burrow` in general pool configuration |
| `BURROW_POSTGRES_USER` | `burrow` in general pool configuration |
| `BURROW_POSTGRES_PASSWORD` | Unset |
| `BURROW_POSTGRES_POOL_MAX` | `10`, positive integer |
| `BURROW_POSTGRES_IDLE_TIMEOUT_MS` | `30000`, positive integer |
| `BURROW_POSTGRES_CONNECTION_TIMEOUT_MS` | `10000`, positive integer |
| `BURROW_POSTGRES_SSL_MODE` | Unset, or `disable` / `verify-full` only |
| `BURROW_POSTGRES_SSL_CA_FILE` | Optional readable PEM certificate; requires `verify-full` |
| `BURROW_POSTGRES_DATA_DIR` | Managed mode `<runtimeRoot>/postgres` |
| `BURROW_POSTGRES_SOCKET_DIR` | Managed mode `<runtimeRoot>/postgres-socket` |
| `BURROW_POSTGRES_LOG_FILE` | Managed mode `<runtimeRoot>/postgres.log` |
| `BURROW_POSTGRES_INITDB` | `initdb` executable |
| `BURROW_POSTGRES_PG_CTL` | `pg_ctl` executable |
| `BURROW_POSTGRES_BIN` | `postgres` executable |
| `BURROW_POSTGRES_LIFECYCLE_TIMEOUT_MS` | `30000` |

Managed startup removes connection URLs/passwords and supplies its Unix socket, port 5432, database `postgres` and current OS username. Consequently, the general pool defaults above do not describe the managed database's effective identity. Managed PostgreSQL does not listen on TCP. External mode validates the expected major and installed `vector` extension without owning database process start/stop.

`verify-full` verifies the configured hostname, including IP literals. Do not combine an explicit SSL mode with URL parameters whose names begin with `ssl`; startup rejects mixed TLS sources. An unset mode does not imply certificate verification. See [persistence](../architecture/persistence.md) for lifecycle requirements.

[Pool/TLS configuration](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/postgres-foundation.mjs#L15-L61) · [Lifecycle](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/postgres-lifecycle-bootstrap.mjs#L13-L32) · [Managed overrides](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/postgres-startup.mjs#L7-L32)

## Context and memory

| Variable | Default |
|---|---:|
| `BURROW_CONTEXT_THRESHOLD` | `0.75` |
| `BURROW_CONTEXT_FRESH_TAIL_COUNT` | `48` |
| `BURROW_CONTEXT_FRESH_TAIL_MAX_TOKENS` | `24000` |
| `BURROW_CONTEXT_LEAF_CHUNK_TOKENS` | `20000` |
| `BURROW_CONTEXT_SUMMARY_TARGET_TOKENS` | `6000` |
| `BURROW_CONTEXT_SUMMARY_MODEL` | Unset |
| `BURROW_CONTEXT_MAX_SWEEP_ITERATIONS` | `4` |
| `BURROW_CONTEXT_SWEEP_DEADLINE_MS` | `120000` |
| `BURROW_ALBDRUCK_PROMPT_MAX_CHARS` | `4000` |
| `BURROW_ALBDRUCK_MAX_PAGE_SIZE` | `200` |

Compression controls normalize invalid values to supported defaults. The retained `BURROW_ALBDRUCK_*` configuration names are compatibility values, not switches that restore the retired Albdruck UI/API. Positive safe integers are required. Explicit history lookup also accepts `BURROW_HISTORY_QUERY_BUDGET_MS` (15000) and `BURROW_HISTORY_LOCK_TIMEOUT_MS` (1000). These are work bounds, not retention settings. [Current mapping](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/config.mjs).

[Compression mapping](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/config.mjs#L248-L274) · [Defaults](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/context-compression.mjs#L57-L79)

## MCP, provider login and mods

| Variable | Default / purpose |
|---|---|
| `BURROW_MCPORTER_ROOT` | `<runtimeRoot>/integrations/mcporter`; requires an active runtime root if not explicit |
| `BURROW_MCPORTER_BIN` | `<mcporterRoot>/node_modules/.bin/mcporter` |
| `BURROW_CLAUDE_BIN` | Login-helper executable; installer/container supplies its managed integration path |
| `BURROW_OPENAI_OAUTH_CALLBACK_HOST` | Loopback callback host; only `localhost`, `127.0.0.1`, `::1` accepted |
| `BURROW_OPENAI_OAUTH_USAGE_URL` | `https://chatgpt.com/backend-api/wham/usage`; specialized usage endpoint override |
| `BURROW_PROVIDER_ERROR_MAX_BYTES` | `16384`; positive safe-integer Forge provider-error capture budget |
| `BURROW_MOD_ARCHIVE_RESERVE_BYTES` | `268435456` (256 MiB); nonnegative safe-integer free-space reserve during mod extraction |

MCP provider-specific environment variables are saved per connection; they are not arbitrary `BURROW_*` service settings. Mod Git credentials are injected into a subprocess internally and should not be configured as global service variables. See [MCP](../concepts/mcp.md) and [extensions](../development/extensions.md).

[mcporter paths](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/mcporter-adapter.mjs#L12-L25) · [OAuth callback](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/openai-oauth-login.mjs#L58-L68) · [Error budget](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/forge-diagnostics.mjs#L1-L9) · [Archive reserve](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/mod-distribution.mjs#L310-L319)

## Compatibility, installer and development-only names

These names occur in the repository but are not a second supported application-configuration system.

| Names | Classification |
|---|---|
| `BURROW_POSTGRES_MODE` | Compatibility fallback for lifecycle selection |
| `BURROW_DATA_ROOT` | Compatibility fallback used by selected server/CLI entry points; prefer the documented runtime root |
| `BURROW_AGENT_DATA_ROOT` | Child/test environment handling; no independent current general config resolver |
| `BURROW_MAIN_SESSION_MAX_AGE_DAYS` / `BURROW_TASK_SESSION_MAX_AGE_DAYS` / `BURROW_SUBAGENT_SESSION_MAX_AGE_DAYS` | Retained resolver defaults 60 / 30 / 7 days; not the current operator-managed retention policy |
| `BURROW_TRACE_MAX_AGE_DAYS` / `BURROW_TRACE_MAX_BYTES` | Retained nullable resolver fields; configure current trace cleanup through settings |
| `BURROW_TRACE_ISOLATION` | Isolated trace layout for tests/debugging; test context also detected automatically |
| `OPENCLAW_OAUTH_CALLBACK_HOST` | Historical fallback for OpenAI loopback callback host |
| `BURROW_HOME` | Generated native launcher installation path |
| `BURROW_POSTGRES_BIN_DIR` | Native installer executable-discovery helper |
| `BURROW_UID`, `BURROW_GID` | Docker build arguments, default 4226; not live process reconfiguration |
| `BURROW_HEALTH_URL`, `BURROW_SERVICE_UNIT` | Operational health/smoke/audit script inputs |
| `BURROW_INSTALL_TEST_ROOT` | Installer test fixture path |
| `BURROW_UI_POSTGRES` | Internal startup marker |
| `BURROW_GIT_USERNAME`, `BURROW_GIT_PASSWORD` | Internal short-lived Git authentication environment |
| `BURROW_CONFIG`, `BURROW_SETTINGS_DB` | Removed-config isolation/check references; do not create JSON/SQLite settings authority |
| `BURROW_TEST_TIMEOUT_MS`, `BURROW_VERIFY_DEPLOYED_ISOLATION`, `BURROW_POSTGRES_LIFECYCLE_REHEARSAL` | Test/rehearsal controls |
| `BURROW_OOM_REPRO_ITERATIONS`, `BURROW_OOM_REPRO_FILE_BYTES`, `BURROW_OOM_REPRO_CALLS_PER_ITERATION`, `BURROW_OOM_REPRO_GC_INTERVAL`, `BURROW_OOM_REPRO_MAX_HEAP_MIB` | Isolated diagnostic reproducer inputs |
| `BURROW_SOURCE_TOKEN` | Assembly CI secret for pinned source access; never a runtime API token |

[Compatibility resolver](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/config.mjs#L225-L261) · [CLI environment](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/cli-postgres.mjs#L6-L19) · [Test isolation](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/scripts/test-runtime.mjs#L100-L125) · [Container build](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/Dockerfile#L11-L19)
