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

Current development places OpenTelemetry under **Settings → Connections → OpenTelemetry** (the public **2026.10.19** UI used General). It exports the same curated traces and supported metrics to **one or more destinations**, with isolated, bounded exporters and a separate metric reader for each destination. One failing or hung destination does not make application work fail or block a healthy peer. OTLP/HTTP JSON and protobuf are supported; gRPC is not.

### Configure destinations

1. Choose **Add destination** in the **Destinations** inventory, or select an existing entry. The inventory is in the additional-settings column; the selected editor is in the main column.
2. Set a descriptive **Name**, **Provider**, endpoint and the provider's connection/authentication fields. Review the receiving service and its data handling before enabling export.
3. Under **Advanced transport**, check enabled signals, protocol, metric temporality and exact signal URLs. A base endpoint receives `/v1/traces` or `/v1/metrics`; exact signal URLs are used unchanged. Keep TLS certificate verification enabled; use a trusted CA certificate where required.
4. Enable the intended destinations and the master **Send telemetry** switch, then **Save changes**. The master requires at least one enabled destination. Additions, removals and edits are drafts until the complete list is saved; a rejected list does not partially replace the saved configuration.
5. Inspect **Effective now**, available exporter diagnostics and actual receiving-service evidence. A saved configuration, active SDK or successful settings response does not prove ingestion. This review did not verify a live collector.

The provider presets are OpenObserve, Grafana Tempo, Grafana Cloud, Jaeger, SigNoz, Uptrace, Elastic, Datadog, New Relic, Honeycomb, Splunk and Custom OTLP. Presets supply configuration defaults, not a guarantee of hosted-service compatibility. Tempo and Jaeger are trace-only. Splunk direct mode is trace-only and requires the exact traces URL ending in `/v2/trace/otlp`; collector mode can export both signals. Direct Datadog requires the service's exact URL for each enabled signal (traces and metrics use different hosts) and delta metrics. **Site** and **Realm** are reference fields, not URL generators. OpenObserve adds the organization to its OTLP base path. Use the provider's actual ingest settings rather than guessing URLs.

**Authentication headers** accepts comma-separated, percent-encoded `key=value` pairs; explicit headers override generated provider headers. Saved credentials and headers are write-only: leave them blank to preserve them for the same destination ID and provider, or use the explicit removal checkbox. Changing an endpoint can therefore send preserved credentials to the new endpoint—verify the destination before saving. Changing provider or destination identity does not inherit the former secrets. Provider switches discard unsaved secret drafts. No saved secret value is shown in the inventory or returned by the settings API.

### Saved settings and environment overrides

Saved destinations and active overrides are shown separately. `BURROW_OTEL_ENABLED` controls only the master switch. A generic or signal-specific OTLP endpoint/header override selects one effective environment transport instead of broadcasting environment credentials to the saved list. Saving does not replace active overrides. Generic and signal-specific environment headers are combined, with signal-specific names winning. See the [environment reference](../reference/environment.md) and [settings API](../reference/api/settings.md) for exact compatibility rules.

An older single-endpoint configuration appears as an **Existing single-endpoint connection** / **Custom OTLP** entry until adopted by a destination-list save; the original provider was not recorded and must not be inferred from its URL. Saving an empty list with export off remains empty across restart. Settings changes apply live to Core, but matching Node Goblin/gateway packages must support the new destination and per-operation transport contract. Saving Core settings is not proof that a remote package was upgraded.

OTel is a curated external projection; PostgreSQL history, Archive and local receipts remain the authoritative evidence. Prompts, answers, tool arguments/output, credentials, private file paths, raw errors and secret-bearing URLs are excluded from this projection. Local diagnostic artifacts can still contain sensitive evidence and need review before sharing.

`burrow.model.request` spans retain available input/output/total/cache-read usage before ending. The same normalized usage feeds cumulative `burrow.model.tokens`: use rates or increases, not sums of successive samples. Cached input is a subset of input, not extra usage. Missing/invalid values are omitted, reported zero is retained, and cost is not inferred. One logical tool execution produces one logical tool span/count/duration; subprocess work is not a second logical tool. Delegated child work retains parent correlation without adding trace carriers to prompts.

Changing or disabling export affects new independent runs. Existing runs and their children retain their exporter generation until they drain, including new process/filesystem operations started by those older runs after the change. A child keeps its generation independently if its parent finishes first. Shutdown remains bounded; disabling settings does not erase already exported data. Exporter failures have independent service-log diagnostics.

The owning run span receives `burrow.model.recovery` events with curated **`burrow.model.recovery.*`** attributes for state, method, attempt bounds, original/last failure and safe failover blocker. Failed request spans keep their observed status even if a later attempt succeeds. This is not a new TTFT instrument or account-health diagnostic subsystem. See [bounded recovery](../architecture/runtime.md#bounded-live-model-recovery).

## Native OpenAI pool metrics

The footer and `GET /api/metrics/provider-pools` report rolling 24-hour/7-day **native OpenAI LB** completed-request windows. Anthropic pools and direct model calls are excluded. Token totals include reported usage from every attempt; missing fields remain unknown and coverage exposes partial reporting. Cached tokens are part of input, not additional tokens. Errors count final failures, not successful failover; cancellations remain in the denominator. [Footer instructions](../guide/models.md#read-the-bottom-row-openai-lb-statistics) explain the display.

When tracing and OTel export are active, `burrow.provider_pool.requests` and `burrow.provider_pool.duration` describe logical calls. `burrow.provider_pool.tokens` attributes reported input/output/cached usage to pool/account/model/outcome. It is separate from existing transport `burrow.model.tokens`; do not add both series as independent usage. Unknown token counts are omitted. This source review does not verify delivery to a collector.

Current OTel runtime exposes bounded overall and per-destination exporter failures and dropped-item counts, plus safe `lastExportFailure` fields (signal, fixed category and numeric HTTP status when known). OTLP partial-success rejection counts appear as `rejectedItems`; a positive count increments failure/drop counters, while a warning-only response does not drop accepted items. Raw collector bodies, warnings and headers are not exposed by these diagnostics. The settings UI shows whether telemetry is active and whether overrides apply. These counters still do not prove ingestion; inspect each destination without sharing authentication headers.

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

## 29 October development delta

Multi-destination export, settings, generation ownership and exporter diagnostics above were checked statically against Backend `4057b50a5d5a9b14d36bb3b70f35781c4b29a9b9` and UI `daa914ae80ed154ce39a76d0b8ca5f84aa278b21` on **2026-10-29**. No collector, remote gateway or application runtime was exercised. Unchanged historical sections retain their earlier qualifications. See [source coverage](../project/source-map.md).
