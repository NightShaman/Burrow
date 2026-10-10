# Authentication

BURROW authenticates access to its operator UI and HTTP API through one configured mode: `none`, `trusted-proxy`, `basic`, or `oidc`. Diagnostics bearer tokens are a separate, restricted access path. Authentication identifies an operator-facing request; it does not create per-agent operating-system isolation.

This page describes the implementation in version **2026.10.10.4**, source commit `c15064dd177788afcdda357a5e545510f754a754`. The behavior is verified from source, not a live deployment or penetration test.

!!! warning "Configure access before exposing the listener"
    Authentication defaults to `none`. The native installer initially binds to loopback, but direct server execution and the container default to `0.0.0.0`. Do not assume the listener is private because the configuration resolver has a loopback fallback. Follow the [deployment checklist](trust-boundaries.md#safe-deployment-checklist).

See [Configuration](../reference/configuration.md) for database/environment precedence, [Environment variables](../reference/environment.md) for every setting, and [Deployment](../operations/deployment.md) for listener and proxy setup. [Source: auth configuration](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/config.mjs#L162-L200) · [Source: direct listener](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/scripts/burrow-ui.mjs#L127-L139)

## Request order

The server processes requests in this order:

1. Apply the configured Host authority policy, then browser-origin and JSON content-type checks for `/api/` and `/auth/`; accepted preflight completes with HTTP 204
2. Handle OIDC login/callback, logout, `/api/auth/discovery`, and `/api/auth/session`
3. Serve public `GET /health` and `GET /api/health`
4. Attempt diagnostics bearer-token authentication
5. If a nonempty bearer token was presented but not accepted, return HTTP 403 `api_token_forbidden`
6. Otherwise apply the configured interactive auth mode
7. Dispatch protected static UI, API, diagnostics, settings, Forge, and mod routes

A rejected bearer token does **not** fall back to a valid Basic/OIDC cookie, trusted proxy identity, or `none` mode. Routes handled before the gate do not enter that bearer decision. An `OPTIONS` success is not proof that the following API request is authorized. [Source: request dispatch](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/scripts/burrow-ui.mjs#L3219-L3246) · [Source: authorization](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/scripts/burrow-ui.mjs#L1460-L1549)

### Public health metadata

`GET /health` and `GET /api/health` intentionally precede authentication. Both return a minimal build-identity projection: `ok: true`, `runtime: "burrow"`, `version`, `buildIdentity`, and optional `releaseProvenance` (`assembly`, `backend`, `ui`, `nodeGoblin`). A configured smoke token is echoed only when the request supplies the matching `x-burrow-smoke-token` header. The build identity is a content hash, not an installation path.

These routes do not return filesystem roots, model settings, policy, or trace configuration and do not run a full runtime/database/model readiness check. `/api/status` remains behind authentication and returns the detailed runtime projection. Host checks and applicable browser-origin checks still precede public health. [Source: request order and health](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/scripts/burrow-ui.mjs#L3224-L3240) · [Source: build identity](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/scripts/build-identity.mjs)

## Interactive modes

### None

`none` admits requests without login. Its verified request context is `{ enabled: false, authenticated: false }`. Routes such as settings and API-token creation remain reachable to anyone who can reach the listener. Use this only inside an appropriately restricted trust boundary.

### Trusted proxy

`trusted-proxy` requires both:

- The socket peer address to exactly match `allowedProxies`
- A nonblank value in the configured identity header, default `x-forwarded-user`

IPv4-mapped IPv6 socket addresses have the `::ffff:` prefix removed before comparison. The default allowlist is `127.0.0.1,::1`; the implementation does not interpret CIDR ranges or use `X-Forwarded-For` as the trusted peer. A rejected peer gets HTTP 401 `proxy_not_allowed`; a missing identity gets HTTP 401 `missing_proxy_user`.

The reverse proxy must perform real authentication, replace or remove client-supplied identity headers, and be the only allowed path to the backend. Any nonblank identity from an allowed peer is accepted; this branch does not apply a user-role or per-agent authorization map. [Source: peer normalization](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/scripts/burrow-ui.mjs#L1381-L1389) · [Source: none and proxy modes](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/scripts/burrow-ui.mjs#L1489-L1506)

### Basic

`basic` requires a configured username and scrypt password hash. Missing configuration returns HTTP 503 `auth_not_configured`. A valid `hc_basic_session` cookie is checked first, followed by HTTP Basic credentials. Missing or invalid credentials return HTTP 401 and `WWW-Authenticate: Basic realm="Burrow"`.

After either successful path, the server issues a new HMAC-signed session cookie. Its signature depends on the password hash; its payload includes the username and expiration. Changing the username or password hash invalidates previously issued cookies. The default lifetime is 43,200 seconds (12 hours), with a minimum of 60 seconds, and successful requests refresh it.

| Basic cookie property | Implemented behavior |
|---|---|
| Name | `hc_basic_session` |
| Flags | `HttpOnly; SameSite=Lax; Path=/` |
| Expiry | Signed expiry plus `Max-Age`; refreshed after successful authentication |
| `Secure` | Set by default; explicit HTTP-development opt-out: `BURROW_UI_AUTH_BASIC_INSECURE_COOKIES=true` |
| Confidentiality | Signed payload, not encrypted payload |

Use HTTPS and keep secure cookies enabled. `POST /auth/logout` clears the Basic session cookie as well as OIDC cookies. A client that continues sending valid Basic credentials can authenticate again. [Source: password/session verification](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/scripts/burrow-ui.mjs#L1413-L1457) · [Source: Basic branch](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/scripts/burrow-ui.mjs#L1508-L1530)

### OpenID Connect

`oidc` requires an issuer, client ID, and client secret. Missing configuration returns HTTP 503 `auth_not_configured`. An unauthenticated non-API `GET` redirects to `/auth/oidc/login`; API requests receive HTTP 401 with a login URL.

The flow discovers the provider, requests an authorization code with state and nonce, exchanges the code, and verifies the ID token through the provider's JWKS with issuer and audience checks. The callback also checks the nonce. Configure an explicit public HTTPS redirect URI behind a proxy; otherwise the callback URI is derived from the request origin.

Optional email and domain allowlists compare lowercased values. When both lists are nonempty, **both** must match. With neither list configured, those additional filters do not restrict provider-authenticated identities. When either allowlist is configured, `email_verified` must be exactly `true`. Existing sessions are rechecked against the current allowlists and an authorization revision covering mode, issuer, client ID, redirect URI, and allowlists; changing that configuration invalidates old sessions.

| OIDC cookie property | Implemented behavior |
|---|---|
| Login state | `burrow_oidc_state`, browser `Max-Age=600` |
| Session | `burrow_oidc_session`, HMAC-signed payload |
| Default flags | `Secure; HttpOnly; SameSite=Lax; Path=/` |
| Session validity | Earlier of ID-token expiry and eight hours; browser `Max-Age` is eight hours |
| Signing secret | OIDC client secret, with settings-key fallback in the helper |
| HTTP-development opt-out | `BURROW_UI_AUTH_OIDC_INSECURE_COOKIES=true` |

Keep secure cookies enabled for deployments. The login-state cookie's ten-minute lifetime is a browser attribute; the callback does not separately reject its stored `createdAt` by age. Session cookies are signed rather than encrypted and should not be treated as secret storage.

`GET /api/auth/session` reports OIDC-session presence and auth configuration. It is not a general Basic/proxy session introspector. `GET /api/auth/discovery` exposes only mode and enabled status before authentication. `GET /api/auth/validate` is behind the main gate and returns HTTP 401 when authentication is disabled. `POST /auth/logout` clears the two OIDC cookies and the Basic cookie; it does not call the identity provider's logout endpoint. [Source: OIDC verification and cookies](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/ui-oidc-auth.mjs#L16-L177) · [Source: auth routes](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/scripts/ui/auth-routes.mjs#L1-L36)

## Diagnostics bearer tokens

The only supported scope is `diagnostics:read`. Tokens contain the `brw_` prefix and 32 random bytes encoded as base64url. PostgreSQL stores a SHA-256 hash and a 12-character prefix, not the complete token. The full value is returned on creation. Tokens support optional future expiry, revocation, and last-use tracking; omitted expiry means no configured expiration. Unsupported or duplicate scopes are rejected. [Source: token store](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/postgres-api-token-store.mjs#L4-L36)

Token management uses the ordinary auth mode:

- `GET /api/settings/api-tokens`: list token metadata and supported scopes
- `POST /api/settings/api-tokens`: create and reveal a token
- `DELETE /api/settings/api-tokens/{tokenId}`: revoke a token

A diagnostics bearer token cannot manage tokens. With auth mode `none`, management is also unauthenticated. A token-authorized request is marked `authenticated: false` in the interactive-auth context, even though its diagnostics access is accepted. [Source: token gate](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/scripts/burrow-ui.mjs#L1482-L1492) · [Source: management routes](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/scripts/burrow-ui.mjs#L3282-L3298)

### Exact allowlist

`/api/health` is public and bypasses token validation despite also appearing in the allowlist. Every entry below is **GET only**. Matching is against the URL pathname; query parameters do not widen the allowed path. Passing this gate does not guarantee that a resource exists.

| Family | Allowed pathnames |
|---|---|
| Runtime | `/api/health`, `/api/status`, `/api/metrics` |
| Inventory and database | `/api/diagnostics/inventory`, `/api/diagnostics/postgres` |
| Forge diagnostics | `/api/diagnostics/forge/jobs`, `/api/diagnostics/forge/jobs/{id}` where the final segment matches `[0-9a-f-]{36}` case-insensitively |
| Mod diagnostics | `/api/diagnostics/mods`; `/api/diagnostics/mods/{modId}/pending`; `/api/diagnostics/mods/{modId}/jobs`; `/api/diagnostics/mods/{modId}/jobs/{jobId}` |
| Agents | `/api/agents`, `/api/agent-status` |
| Sessions | `/api/sessions`, `/api/sessions/{id}` with exactly one nonempty path segment after `/sessions/` |
| Context | `/api/session/context`, `/api/session/context-status`, `/api/context` |
| Active runs | `/api/chat/runs/active` |
| Traces | `/api/traces` and every pathname beginning `/api/traces/` |
| Archive | `/api/archive/calendar`; `/api/archive/runs` and every pathname beginning `/api/archive/runs/`; `/api/archive/sessions` and every pathname beginning `/api/archive/sessions/` |

In the mod patterns, `modId` matches `[a-z0-9-]+` and `jobId` matches `[A-Za-z0-9_-]+`. The Forge pattern is the literal gate's character/length check, not a claim of complete UUID validation.

The token does not grant chat submission, mutation, ordinary settings, model/MCP connection management, arbitrary mod routes, general export routes, or Forge generation/artifact access. [Source: complete allowlist](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/scripts/burrow-ui.mjs#L1465-L1479)

!!! warning "Read-only can include private content"
    Session detail, context, traces, and archived sessions/runs can expose conversations and operational content. Issue diagnostics tokens only to trusted consumers, give them an expiry, and revoke them when no longer needed. `/api/diagnostics/inventory` is specifically count-only, but a token used for that endpoint still has the full allowlist above.

[Source: inventory projection](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/scripts/burrow-ui.mjs#L3270-L3280)

## Browser-origin controls

Requests under `/api/` and `/auth/` are checked against their origin. A supplied Origin must match the request origin, an HTTP(S) origin with the same host/port, or an exact entry in `BURROW_UI_ALLOWED_ORIGINS`; otherwise the response is HTTP 403 `browser_origin_not_allowed`. Allowed origins are echoed with `Vary: Origin` and `Access-Control-Allow-Credentials: true`, rather than wildcard CORS. Requests without an Origin remain possible for non-browser clients.

API mutations (`POST`, `PUT`, `PATCH`, `DELETE`) require `application/json`, except a bodyless DELETE. Non-JSON mutations receive HTTP 415 `application_json_required`. These checks reduce browser-origin/form attack paths; they are not an independent identity or tenant boundary. [Source: browser policy](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/browser-origin-policy.mjs) · [Source: CORS application](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/scripts/burrow-ui.mjs#L1556-L1574)

Host authority enforcement is opt-in through `BURROW_UI_ALLOWED_HOSTS` (exact host/port authorities, no wildcards). With enforcement enabled, `none` mode rejects authorities outside that list; malformed authorities and absolute request targets that override the checked authority are rejected. `BURROW_UI_TRUSTED_PROXIES` names exact peer IPs allowed to supply forwarded host/protocol. This is separate from the trusted-proxy authentication peer list. Configure and verify both when applicable. [Source: Host authority policy](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/http-authority.mjs)

The shared JSON-body reader has a default 96 MiB ceiling and 30-second read timeout, plus structural limits of depth 128 and 1,000,000 items. Configure `BURROW_REQUEST_MAX_BYTES`, `BURROW_REQUEST_TIMEOUT_MS`, `BURROW_JSON_MAX_DEPTH`, and `BURROW_JSON_MAX_ITEMS` for the workload. These are allocation/traversal budgets, not request-rate limiting. Continue to use appropriate network access controls and rate limits, and verify the deployed behavior. [Source: body budgets](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/request-resource-budgets.mjs)

Review [Trust boundaries](trust-boundaries.md), [Permissions](permissions.md), and the [API reference](../reference/api.md) before integrating a client.
