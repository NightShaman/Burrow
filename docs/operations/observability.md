# Observability


!!! warning "Earlier technical reference"
    This page is retained from earlier documentation and has not been fully revalidated for the public 2026.10.19 release. Its revision-specific links and examples may describe older or development behavior. Start with the [current public-release user guide](../guide/installation.md); do not use this page alone to select installation commands, image tags, or security settings.


Use runtime receipts, persisted history, logs, and provider-request evidence to answer different questions. A green process or successful HTTP response is not proof that the requested work completed.

## Health and status

```sh
curl -fsS http://127.0.0.1:42817/health
```

Both `/health` and `/api/health` return a small public readiness/build-identity response before the authentication gate. Detailed `/api/status` passes through authentication and can contain operationally sensitive runtime information.

Inspect health `ok` and `version`; inspect model/trace details through authenticated status. A missing model selection can coexist with a running service. The Docker probe additionally accepts 401 as HTTP liveness; it is not a model or integration check.

## Service and container logs

Native user service:

```sh
"$HOME/.burrow/bin/burrow" service status
"$HOME/.burrow/bin/burrow" service logs -n 200
```

Container:

```sh
docker compose ps
docker compose logs --tail=200 burrow
```

The runtime also writes bounded event records to `<runtime-root>/logs/server-events.jsonl`. Server events include listener startup/error, request duration/status, request/client/socket errors, disconnects, shutdown progress, and unhandled exceptions. A port conflict is logged as `EADDRINUSE`; do not launch a second foreground process merely to test a running service.

## Chat and active work

The chat transport can return NDJSON when the request accepts `application/x-ndjson`. It carries run, route, model, tool, assistant delta, verification, and terminal events. HTTP 200 begins the stream; completion still requires interpreting the terminal result.

- `run.completed` contains a result whose `ok` must be inspected
- `run.failed`, `run.cancelled`, and `run.superseded` are distinct outcomes
- Disconnecting the browser detaches the client; it does not necessarily cancel the agent
- `/stop` or the explicit cancel endpoint requests cancellation

`GET /api/chat/runs/active` exposes active parent runs and child-work summaries. Scope observations by agent and session. Group-channel runs have their own participant identities and cancellation route.

## Traces and persisted evidence

Use **Archive** or the trace endpoints to inspect completed work. Current CLI readers resolve lifecycle-aware connection settings, including the private managed socket. They connect to an already running database; see [managed reader connection](../reference/cli.md#managed-reader-connection). The [CLI](../reference/cli.md) can retrieve trace summaries with PostgreSQL conversation evidence:

```sh
"$HOME/.burrow/bin/burrow" trace --agent-id assistant --latest --json
"$HOME/.burrow/bin/burrow" trace --agent-id assistant --run-id RUN_ID --tool-output
"$HOME/.burrow/bin/burrow" session-search \
  --agent-id assistant --session-id default --query 'decision' --json
```

Replace `assistant` and `RUN_ID` with actual identifiers. These commands need a reachable configured database and key. They do not start the database; application composition may check/apply pending migrations.

`/context` shows the current reconstructible context. `/context full` displays captured provider-visible request context where available. It can expose conversation and tool evidence; use it locally and review carefully before sharing.

A receipt can show that a command ran without proving the user's overall objective. Prefer concrete changed-file, exit-status, verification, and terminal-result evidence over narrative success claims.

## OpenTelemetry

Public **2026.10.19** includes an OpenTelemetry settings surface under **Settings → General**. Saved operator settings and active environment overrides are shown separately; saving does not override an environment-enforced value. Review the effective endpoint and exported data before enabling collection. This source review did not verify delivery to a live collector.

## Diagnostic API access

A `diagnostics:read` token is limited to the server's allowed GET routes. It is not a general chat/settings API credential. Token creation/revocation belongs to an authenticated operator, and some read surfaces remain outside the token allowlist. See [authentication](../security/authentication.md) and [API reference](../reference/api.md).

Do not publish tokens, complete provider requests, attachment contents, or raw trace archives in an issue. Redaction is bounded and does not make every operational artifact safe to share. Progress can contain commands, paths, queries, and error text.

## Maintenance tools and limitations

The source includes `health-check.mjs`, `service-smoke.mjs`, `operational-audit.mjs`, and a standalone trace viewer. Their roles differ:

| Tool | Purpose | Caveat |
|---|---|---|
| Health check | Fetch/status projection | Old summary fields may be irrelevant to current configuration |
| Service smoke | systemd and HTTP check | Uses system-level systemctl, not the normal user unit |
| Operational audit | Doctor, service smoke, Git, retention | Doctor uses composed PostgreSQL stores and can apply migrations; audit still depends on service scope/Git |
| Trace UI | Local filesystem trace summary | Loopback port 8765 and cwd/traces; not the main UI/database authority |

For production acceptance, use the correct supervisor scope, authenticated API evidence where needed, and an actual representative request. See [troubleshooting](troubleshooting.md) and [procedures](procedures.md).




## Targeted source review

Corrections on this page were checked against public **2026.10.19**; any newer development behavior is labeled separately. This was static source inspection, not a live deployment test. Other retained details remain subject to the earlier-reference warning.

- [backend/scripts/burrow-ui.mjs](https://github.com/GoblinKing-Burrow/Burrow/blob/aa5a30da683a3a8ea919025f107ff53f182ef8d6/backend/scripts/burrow-ui.mjs)
- [backend/src/cli-postgres.mjs](https://github.com/GoblinKing-Burrow/Burrow/blob/aa5a30da683a3a8ea919025f107ff53f182ef8d6/backend/src/cli-postgres.mjs)
- [ui/src/features/settings/OpenTelemetrySettings.tsx](https://github.com/GoblinKing-Burrow/Burrow/blob/aa5a30da683a3a8ea919025f107ff53f182ef8d6/ui/src/features/settings/OpenTelemetrySettings.tsx)
