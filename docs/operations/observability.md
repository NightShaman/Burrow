# Observability

Use runtime receipts, persisted history, logs, and provider-request evidence to answer different questions. A green process or successful HTTP response is not proof that the requested work completed.

## Health and status

```sh
curl -fsS http://127.0.0.1:42817/health
```

`/health` is public in the reviewed server and returns runtime status, including version, paths, listener/auth mode, model configuration, and trace information. `/api/health` and `/api/status` pass through the authentication boundary. Treat either payload as operationally sensitive.

Inspect `ok`, `version`, and the relevant model/trace fields. A missing model selection can coexist with a running service. The Docker probe additionally accepts 401 as HTTP liveness; it is not a model or integration check.

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

Use **Archive** or the trace endpoints to inspect completed work. For CLI readers on a default managed installation, put the desired command inside the [explicit private-socket connection subshell](../reference/cli.md#managed-reader-connection), replacing its final trace command. The subshell does not configure later standalone commands; lifecycle settings alone do not populate their connection environment. The [CLI](../reference/cli.md) can retrieve trace summaries with PostgreSQL conversation evidence:

```sh
"$HOME/.burrow/bin/burrow" trace --agent-id assistant --latest --json
"$HOME/.burrow/bin/burrow" trace --agent-id assistant --run-id RUN_ID --tool-output
"$HOME/.burrow/bin/burrow" session-search \
  --agent-id assistant --session-id default --query 'decision' --json
```

Replace `assistant` and `RUN_ID` with actual identifiers. These commands need a reachable configured database and key. They do not start the database; application composition may check/apply pending migrations.

`/context` shows the current reconstructible context. `/context full` displays captured provider-visible request context where available. It can expose conversation and tool evidence; use it locally and review carefully before sharing.

A receipt can show that a command ran without proving the user's overall objective. Prefer concrete changed-file, exit-status, verification, and terminal-result evidence over narrative success claims.

## Diagnostic API access

A `diagnostics:read` token is limited to the server's allowed GET routes. It is not a general chat/settings API credential. Token creation/revocation belongs to an authenticated operator, and some read surfaces remain outside the token allowlist. See [authentication](../security/authentication.md) and [API reference](../reference/api.md).

Do not publish tokens, complete provider requests, attachment contents, or raw trace archives in an issue. Redaction is bounded and does not make every operational artifact safe to share. Progress can contain commands, paths, queries, and error text.

## Maintenance tools and limitations

The source includes `health-check.mjs`, `service-smoke.mjs`, `operational-audit.mjs`, and a standalone trace viewer. Their roles differ:

| Tool | Purpose | Caveat |
|---|---|---|
| Health check | Fetch/status projection | Old summary fields may be irrelevant to current configuration |
| Service smoke | systemd and HTTP check | Uses system-level systemctl, not the normal user unit |
| Operational audit | Doctor, service smoke, Git, retention | Doctor has a store-wiring gap; also depends on service scope/Git |
| Trace UI | Local filesystem trace summary | Loopback port 8765 and cwd/traces; not the main UI/database authority |

For production acceptance, use the correct supervisor scope, authenticated API evidence where needed, and an actual representative request. See [troubleshooting](troubleshooting.md) and [procedures](procedures.md).

## Source evidence

- [Server status, transport, lifecycle](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/scripts/burrow-ui.mjs)
- [Observability routes](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/scripts/ui/observability-routes.mjs)
- [Runtime server logger](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/runtime-server-log.mjs)
- [Service smoke implementation](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/scripts/service-smoke.mjs)
