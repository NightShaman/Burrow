# Authentication


!!! warning "Earlier technical reference"
    This page is retained from earlier documentation and has not been fully revalidated for the public 2026.10.19 release. Its revision-specific links and examples may describe older or development behavior. Start with the [current operator guide](../guide/installation.md); do not use this page alone to select installation commands, image tags, or security settings.


BURROW authenticates access to its operator UI and HTTP API through one configured mode: `none`, `trusted-proxy`, `basic`, or `oidc`. Diagnostics bearer tokens are a separate, restricted access path. Authentication identifies an operator-facing request; it does not create per-agent operating-system isolation.

The authentication gates, browser controls and diagnostics scope below were checked against public release **2026.10.19**, source commit `aa5a30da683a3a8ea919025f107ff53f182ef8d6`. This is static source review, not a live deployment or penetration test; the broader earlier-reference warning still applies.


!!! warning "Configure access before exposing the listener"
    Authentication defaults to `none`. The native installer initially binds to loopback, but direct server execution and the container default to `0.0.0.0`. Do not assume the listener is private because the configuration resolver has a loopback fallback. Follow the [deployment checklist](trust-boundaries.md#safe-deployment-checklist).


See [Configuration](../reference/configuration.md) for database/environment precedence, [Environment variables](../reference/environment.md) for every setting, and [Deployment](../operations/deployment.md) for listener and proxy setup.
## Request order

The server processes requests in this order:

1. Apply the configured Host authority policy, then browser-origin and JSON content-type checks for `/api/` and `/auth/`; accepted preflight completes with HTTP 204
2. Handle OIDC login/callback, logout, `/api/auth/discovery`, and `/api/auth/session`
3. Serve public `GET /health` and `GET /api/health`
4. Handle `POST /api/events/github` through its separate HMAC-signed webhook receiver
5. Attempt diagnostics bearer-token authentication
6. If a nonempty bearer token was presented but not accepted, return HTTP 403 `api_token_forbidden`
7. Otherwise apply the configured interactive auth mode
8. Dispatch protected static UI, API, diagnostics, settings, Forge, and mod routes

A rejected bearer token does **not** fall back to a valid Basic/OIDC cookie, trusted proxy identity, or `none` mode. Routes handled before the gate do not enter that bearer decision. An `OPTIONS` success is not proof that the following API request is authorized.
The workflow-completion webhook is mounted before interactive UI authentication, but is not anonymous ingestion: it verifies `x-hub-signature-256` against the configured receiver secret. Its settings, watch management and event reads remain behind the normal operator gate. Host/browser checks still precede the webhook. This ordering was checked against current Backend `32ff99dfc0317635f5c7aa53b4c9ec18266d4c09`; see [task workflows](../guide/tasks.md) for setup.

### Public health metadata

`GET /health` and `GET /api/health` intentionally precede authentication. Both return a minimal build-identity projection: `ok: true`, `runtime: "burrow"`, `version`, `buildIdentity`, and optional `releaseProvenance` (`assembly`, `backend`, `ui`). Optional mods such as Node Goblin have independent release identities and are not part of Burrow's assembly provenance. A configured smoke token is echoed only when the request supplies the matching `x-burrow-smoke-token` header. The build identity is a content hash, not an installation path.

These routes do not return filesystem roots, model settings, policy, or trace configuration and do not run a full runtime/database/model readiness check. `/api/status` remains behind authentication and returns the detailed runtime projection. Host checks and applicable browser-origin checks still precede public health.
## Interactive modes

### None

`none` admits requests without login. Its verified request context is `{ enabled: false, authenticated: false }`. Routes such as settings and API-token creation remain reachable to anyone who can reach the listener. Use this only inside an appropriately restricted trust boundary. Historical public 2026.10.19 had an exception for `GET`/`PUT /api/operator/mods/{modId}/access`. Current Core accepts direct UI requests in `none` mode, requires operator login when authentication is enabled, and rejects API tokens for that route. Check the installed version; this contract comparison is not a live authentication test.

### Trusted proxy

`trusted-proxy` requires both:

- The socket peer address to exactly match `allowedProxies`
- A nonblank value in the configured identity header, default `x-forwarded-user`

IPv4-mapped IPv6 socket addresses have the `::ffff:` prefix removed before comparison. The default allowlist is `127.0.0.1,::1`; the implementation does not interpret CIDR ranges or use `X-Forwarded-For` as the trusted peer. A rejected peer gets HTTP 401 `proxy_not_allowed`; a missing identity gets HTTP 401 `missing_proxy_user`.

The reverse proxy must perform real authentication, replace or remove client-supplied identity headers, and be the only allowed path to the backend. Any nonblank identity from an allowed peer is accepted; this branch does not apply a user-role or per-agent authorization map.
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

Use HTTPS and keep secure cookies enabled. `POST /auth/logout` clears the Basic session cookie as well as OIDC cookies. A client that continues sending valid Basic credentials can authenticate again.
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

`GET /api/auth/session` reports OIDC-session presence and auth configuration. It is not a general Basic/proxy session introspector. `GET /api/auth/discovery` exposes only mode and enabled status before authentication. `GET /api/auth/validate` is behind the main gate and returns HTTP 401 when authentication is disabled. `POST /auth/logout` clears the two OIDC cookies and the Basic cookie; it does not call the identity provider's logout endpoint.
### Authentik setup and exact issuer identity

This subsection was checked on 27 October 2026 against Backend `32ff99dfc0317635f5c7aa53b4c9ec18266d4c09`, including the full issuer-preservation fix. It is current-source guidance, not verification of an operator’s live login or a claim about an older installed release.

1. In Authentik’s administration interface, create an application/provider pair using **OAuth2/OIDC**. See the official [provider creation instructions](https://docs.goauthentik.io/add-secure-apps/providers/oauth2/create-oauth2-provider/).
2. Use a confidential authorization-code client with a client secret and an asymmetric signing key published in the provider’s JWKS. Burrow exchanges the code using HTTP Basic client authentication and validates the signed ID token; it is not a public browser-only client.
3. Register this exact callback, substituting your public Burrow origin:

   ```text
   https://burrow.example.com/auth/oidc/callback
   ```

   Use an exact/strict redirect entry rather than a wildcard. Set Burrow’s redirect URI to the same value. `/auth/callback`, the Authentik application URL, and a callback with an added trailing slash are not this route.
4. Keep Authentik’s per-provider issuer mode. Its default issuer is `https://auth.example.com/application/o/burrow/`, including the final slash; the application slug must match your provider. The discovery document is beneath that path at `.well-known/openid-configuration`. Authentik’s global issuer mode instead identifies the root while leaving discovery under the application path. Burrow derives discovery from its issuer and has no separate discovery-URL setting, so do not substitute that global mode. See [Authentik’s issuer and endpoint reference](https://docs.goauthentik.io/add-secure-apps/providers/oauth2/#issuer-mode).
5. In **Settings → Connections → Authentication**, select OIDC and enter the issuer, client ID, client secret and public redirect URI. Request `openid,email,profile` and enable the corresponding provider scope mappings. Apply the intended provider access policy and Burrow email/domain allowlists deliberately; empty Burrow allowlists do not restrict provider-authenticated identities.

The complete issuer-preservation fix first shipped in development build **2026.10.26.13**; **2026.10.26.12** contained only a partial fix. Older settings may already have lost the final slash. Upgrading does not reconstruct that stored value: re-enter and save the provider’s exact issuer after upgrading, then start a new login. This historical build receipt is not a claim that every public mirror or installed version contains the fix.

Copy the discovery document’s `issuer` value exactly into Burrow, including any path and trailing slash. Current Core preserves it through settings save/read, runtime configuration, discovery validation, token `iss` validation and the session authorization revision. Only construction of the discovery request URL strips trailing slashes. Changing only the issuer’s final slash is an identity change, not cosmetic normalization, and invalidates old Burrow sessions.

The same configuration can be supplied through the documented environment variables; deployment environment values override saved settings. The non-secret example is:

```dotenv
BURROW_UI_AUTH_MODE=oidc
BURROW_UI_AUTH_OIDC_ISSUER=https://auth.example.com/application/o/burrow/
BURROW_UI_AUTH_OIDC_CLIENT_ID=burrow
BURROW_UI_AUTH_OIDC_REDIRECT_URI=https://burrow.example.com/auth/oidc/callback
BURROW_UI_AUTH_OIDC_SCOPES=openid,email,profile
```

Supply the actual client secret through your protected configuration mechanism or the write-only Settings field; do not put it in documentation, screenshots or copied troubleshooting logs. Keep Secure cookies enabled for HTTPS deployments. Changing a deployment environment value requires restarting/recreating the process; saving supported UI settings is a separate path.

### Session lifetime and login troubleshooting

- **Login expires earlier than eight hours:** Burrow’s signed session ends at the earlier of the ID token’s `exp` and eight hours after callback. The eight-hour browser cookie does not extend that signed expiry. Inspect the provider-issued ID-token lifetime; an Authentik login-session lifetime is a different setting. Burrow does not refresh tokens or implement sliding OIDC sessions, and adding `offline_access` does not add that behavior.
- **Issuer mismatch:** compare the saved issuer, discovery `issuer`, and ID-token `iss` exactly, including the slash. `oidc_discovery_issuer_mismatch` identifies a discovery mismatch. Do not remove the slash to work around an older Burrow normalization bug; update to a build containing the fix and retain the provider’s actual issuer.
- **Redirect mismatch:** compare the provider’s registered callback with Burrow’s public redirect URI, including HTTPS, host, port and `/auth/oidc/callback`. Behind a proxy, configure the explicit browser-facing URI rather than relying on a derived origin.
- **Discovery/token/JWKS failure:** check that the Burrow server can reach the configured provider endpoints with valid TLS. Browser reachability alone does not establish server reachability. Fix the specific endpoint/network error rather than disabling authentication or cookie protections.
- **Email rejected:** an email/domain rule requires `email_verified: true`; when both lists are populated, both must match. Check the provider’s claims and intended access policy, not just successful provider login.
- **Repeated login after configuration change:** issuer, client ID, callback, mode or allowlist changes can invalidate the saved authorization revision. Start a new login. Burrow logout clears its local cookies, not the provider session.

The checked-in tests cover exact issuers both with and without a trailing slash, signed-token callback validation, and settings save/read using controlled fixtures. No identity-provider login or application test was performed during this documentation pass.

### Operator recovery without disabling authentication

Before enabling OIDC, arrange deployment-controlled rollback with known working credentials. Keeping an old Basic-authenticated tab open is not a fallback after the mode changes. OIDC mode does **not** fall back to saved Basic credentials. A Basic login cookie or Authorization header is not an alternate login while the selected mode remains OIDC.

If an operator with deployment access needs temporary recovery, use a restricted HTTPS/administrative access path and only switch to Basic when a working, known username/password and its valid stored scrypt hash already exist. A temporary `BURROW_UI_AUTH_MODE=basic` deployment override selects that mode; restart/recreate the process to apply it. The Basic username/hash must resolve from saved settings or protected `BURROW_UI_AUTH_BASIC_USERNAME` / `BURROW_UI_AUTH_BASIC_PASSWORD_HASH` configuration. Do not put a plaintext password in the hash field, invent credentials, or publish them in support output. Missing Basic configuration returns `auth_not_configured`, not access.

Repair and save OIDC settings while authenticated through that deliberate recovery mode. Remove the temporary mode override, restart/recreate, and verify OIDC in a separate browser session; the override otherwise continues to win over saved settings. Do **not** use `none`, database deletion or an encryption-key reset as the recovery shortcut. If no known working Basic credentials exist, keep access restricted and use an explicitly planned administrator recovery procedure rather than guessing credentials or disabling the gate. These are recovery instructions, not changes performed by this documentation task.

## Diagnostics bearer tokens

The only supported scope is `diagnostics:read`. Tokens contain the `brw_` prefix and 32 random bytes encoded as base64url. PostgreSQL stores a SHA-256 hash and a 12-character prefix, not the complete token. The full value is returned on creation. Tokens support optional future expiry, revocation, and last-use tracking; omitted expiry means no configured expiration. Unsupported or duplicate scopes are rejected.

Token management uses the ordinary auth mode:

- `GET /api/settings/api-tokens`: list token metadata and supported scopes
- `POST /api/settings/api-tokens`: create and reveal a token
- `DELETE /api/settings/api-tokens/{tokenId}`: revoke a token

A diagnostics bearer token cannot manage tokens. With auth mode `none`, management is also unauthenticated. A token-authorized request is marked `authenticated: false` in the interactive-auth context, even though its diagnostics access is accepted.
### Exact allowlist

`/api/health` is public and bypasses token validation despite also appearing in the allowlist. Every entry below is **GET only**. Matching is against the URL pathname; query parameters do not widen the allowed path. Passing this gate does not guarantee that a resource exists.

| Family | Allowed pathnames |
|---|---|
| Runtime | `/api/health`, `/api/status`, `/api/metrics` |
| Inventory and database | `/api/diagnostics/inventory`, `/api/diagnostics/postgres` |
| Brain diagnostics | `/api/diagnostics/brains`, `/api/diagnostics/brains/memories`, `/api/diagnostics/brains/embedding-jobs` |
| Forge diagnostics | `/api/diagnostics/forge/jobs`, `/api/diagnostics/forge/jobs/{id}` where the final segment matches `[0-9a-f-]{36}` case-insensitively |
| Mod diagnostics | `/api/diagnostics/mods`; `/api/diagnostics/mods/{modId}/pending`; `/api/diagnostics/mods/{modId}/jobs`; `/api/diagnostics/mods/{modId}/jobs/{jobId}` |
| Agents | `/api/agents`, `/api/agent-status` |
| Sessions | `/api/sessions`, `/api/sessions/{id}` with exactly one nonempty path segment after `/sessions/` |
| Context | `/api/session/context`, `/api/session/context-status`, `/api/context` |
| Active runs | `/api/chat/runs/active` |
| Traces | `/api/traces` and every pathname beginning `/api/traces/` |
| Archive | `/api/archive/calendar`; `/api/archive/runs` and every pathname beginning `/api/archive/runs/`; `/api/archive/sessions` and every pathname beginning `/api/archive/sessions/` |

In the mod patterns, `modId` matches `[a-z0-9-]+` and `jobId` matches `[A-Za-z0-9_-]+`. The Forge pattern is the literal gate's character/length check, not a claim of complete UUID validation.

The token does not grant chat submission, mutation, ordinary settings, model/MCP connection management, arbitrary mod routes, general export routes, or Forge generation/artifact access.


!!! warning "Read-only can include private content"
    Session detail, context, traces, and archived sessions/runs can expose conversations and operational content. Issue diagnostics tokens only to trusted consumers, give them an expiry, and revoke them when no longer needed. `/api/diagnostics/inventory` is specifically count-only, but a token used for that endpoint still has the full allowlist above.


## Browser-origin controls

By default, requests under `/api/` and `/auth/` are checked against their origin. With origin checking enabled, a supplied Origin must match the request origin, an HTTP(S) origin with the same host/port, or an exact entry in `BURROW_UI_ALLOWED_ORIGINS`; otherwise the response is HTTP 403 `browser_origin_not_allowed`. Allowed origins are echoed with `Vary: Origin` and `Access-Control-Allow-Credentials: true`, rather than wildcard CORS. Requests without an Origin remain possible for non-browser clients. `GET`/`PUT /api/settings/browser-origin` reads/saves the boolean `checkOrigin`; `BURROW_UI_ORIGIN_CHECK` overrides that saved value. Disabling it skips the Origin allowlist check and echoes supplied origins, so keep it enabled unless an independently controlled deployment requires otherwise. The JSON content-type checks below remain active even when origin checking is disabled.

API mutations (`POST`, `PUT`, `PATCH`, `DELETE`) require `application/json`, except a bodyless DELETE. Non-JSON mutations receive HTTP 415 `application_json_required`. These checks reduce browser-origin/form attack paths; they are not an independent identity or tenant boundary.
Host authority enforcement is opt-in through `BURROW_UI_ALLOWED_HOSTS` (exact host/port authorities, no wildcards). With enforcement enabled, `none` mode rejects authorities outside that list; malformed authorities and absolute request targets that override the checked authority are rejected. `BURROW_UI_TRUSTED_PROXIES` names exact peer IPs allowed to supply forwarded host/protocol. This is separate from the trusted-proxy authentication peer list. Configure and verify both when applicable.

The shared JSON-body reader has a default 96 MiB ceiling and 30-second read timeout, plus structural limits of depth 128 and 1,000,000 items. Configure `BURROW_REQUEST_MAX_BYTES`, `BURROW_REQUEST_TIMEOUT_MS`, `BURROW_JSON_MAX_DEPTH`, and `BURROW_JSON_MAX_ITEMS` for the workload. These are allocation/traversal budgets, not request-rate limiting. Continue to use appropriate network access controls and rate limits, and verify the deployed behavior.

Review [Trust boundaries](trust-boundaries.md), [Permissions](permissions.md), and the [API reference](../reference/api.md) before integrating a client.

## Targeted source review

Corrections on this page were checked against public **2026.10.19**; any newer development behavior is labeled separately. This was static source inspection, not a live deployment test. Other retained details remain subject to the earlier-reference warning.

- [backend/scripts/burrow-ui.mjs](https://github.com/GoblinKing-Burrow/Burrow/blob/aa5a30da683a3a8ea919025f107ff53f182ef8d6/backend/scripts/burrow-ui.mjs)
- [backend/src/browser-origin-policy.mjs](https://github.com/GoblinKing-Burrow/Burrow/blob/aa5a30da683a3a8ea919025f107ff53f182ef8d6/backend/src/browser-origin-policy.mjs)
- [backend/src/mod-authority.mjs](https://github.com/GoblinKing-Burrow/Burrow/blob/aa5a30da683a3a8ea919025f107ff53f182ef8d6/backend/src/mod-authority.mjs)
- [backend/src/ui-oidc-auth.mjs](https://github.com/GoblinKing-Burrow/Burrow/blob/aa5a30da683a3a8ea919025f107ff53f182ef8d6/backend/src/ui-oidc-auth.mjs)
