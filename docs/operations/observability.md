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

Current development emits structured JSON lines directly to the service console: `info` to stdout and `warn`/`error`/`fatal` to stderr; debug detail stays in the file sink. Reading `docker compose logs` or the native journal does not require an application login, diagnostics token or telemetry collector. The startup summary reports effective build/auth source, database, scheduler and mod counts; the existing listening line remains. A port conflict is logged as `EADDRINUSE`; do not launch another foreground process to test a running service.

Records carry UTC time, service, severity, component and event, plus available request/agent/session/run/task and existing trace correlation. `x-request-id` is accepted or generated and echoed. Request paths are templated without query strings. Ordinary successful polling and routine validation do not flood the console. A logical failed run can be logged even when its HTTP transport status is 200: distinguish `status`, `resultStatus` and `upstreamStatus`.

The first warning/error appears immediately. Equivalent repeats are summarized at most once per 60 seconds and at shutdown; a recovery resets the repeat bucket. Correlation on a repeat summary represents the first event, not every occurrence. Background dependency and mod lifecycle failures are also visible; a disabled feature is not reported as a recovered dependency.

The detailed sink is `<runtime-root>/logs/server-events.jsonl` (`/data/logs/server-events.jsonl` in the standard container), continuously rotated at **8 MiB** with **three backups** (`.1`–`.3`). Files use mode 0600 and the log directory 0700. Console and file writes fail independently. Rotation assumes the normal single owning logger, not a cross-process lock. Direct mod stdout/stderr is drained with bounded stream notices rather than copied as raw prose. Curated diagnostics avoid credentials and raw provider bodies, but explicit logger messages remain a trusted boundary: review logs before sharing them.

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

Current development places OpenTelemetry under **Settings → Connections → OpenTelemetry** (the public **2026.10.19** UI used General). Saved operator settings and active environment overrides are shown separately; saving does not override an environment-enforced value. Trace and metric endpoints/headers are signal-specific; an exact signal URL is distinct from a base URL. Review the effective destination and exported data before enabling collection. This source review did not verify live collector delivery.

`burrow.model.request` spans retain available input/output/total/cache-read usage before ending. The same normalized usage feeds cumulative `burrow.model.tokens`: use rates or increases, not sums of successive samples. Cached input is a subset of input, not extra usage. Missing/invalid values are omitted, reported zero is retained, and cost is not inferred. One logical tool execution produces one logical tool span/count/duration; subprocess work is not a second logical tool. Delegated child work retains parent correlation without adding trace carriers to prompts.

Changing or disabling export affects new independent runs. Existing runs and their children retain their exporter generation until they drain, with bounded shutdown; disabling settings does not erase already exported data. Exporter failures have independent service-log diagnostics.

The owning run span receives `burrow.model.recovery` events with curated **`burrow.model.recovery.*`** attributes for state, method, attempt bounds, original/last failure and safe failover blocker. Failed request spans keep their observed status even if a later attempt succeeds. This is not a new TTFT instrument or account-health diagnostic subsystem. See [bounded recovery](../architecture/runtime.md#bounded-live-model-recovery).

## Native OpenAI pool metrics

The footer and `GET /api/metrics/provider-pools` report rolling 24-hour/7-day **native OpenAI LB** completed-request windows. Anthropic pools and direct model calls are excluded. Token totals include reported usage from every attempt; missing fields remain unknown and coverage exposes partial reporting. Cached tokens are part of input, not additional tokens. Errors count final failures, not successful failover; cancellations remain in the denominator. [Footer instructions](../guide/models.md#read-the-bottom-row-openai-lb-statistics) explain the display.

When tracing and OTel export are active, `burrow.provider_pool.requests` and `burrow.provider_pool.duration` describe logical calls. `burrow.provider_pool.tokens` attributes reported input/output/cached usage to pool/account/model/outcome. It is separate from existing transport `burrow.model.tokens`; do not add both series as independent usage. Unknown token counts are omitted. This source review does not verify delivery to a collector.

Current OTel runtime exposes bounded exporter diagnostics through its runtime status projection; the settings UI shows whether telemetry is active and whether overrides apply. A saved endpoint or active runtime does not prove collector delivery. Inspect available diagnostics without sharing authentication headers.

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

## Queued inputs, side questions, previews and events

Active-run summaries distinguish main and side-question lanes; correlate by agent/session/run identity rather than mixing their activity. Inspect explicit chat input status and terminal result after acceptance. A side-question result is a frozen historical view, not a fresh inspection. Compaction progress reports started/completed/failed; a no-op can complete with `compressed:false`. Retained compaction receipts and context-meter refresh show rotation outcome rather than implying a model answered.

Workflow event views separate GitHub conclusion from Burrow handling status; accepted or interrupted work requires its actual run evidence. A ready webhook receiver proves local signature setup only. Dream previews do not save memories/settings, but nonempty previews retain filesystem request/response/lifecycle diagnostics under normal evidence retention. Do not publish those artifacts without reviewing their contents.

## 28 October development delta

Changed behavior above was checked statically against Backend `a04acb16b0eab2a910c3ef0fb452622df81a05cb` on **2026-10-28**. This is not a live provider, database or collector test, nor a revalidation of unchanged historical sections. See [source coverage](../project/source-map.md).
