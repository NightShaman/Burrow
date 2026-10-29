import { context, trace, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { performance } from 'node:perf_hooks';
import { configuredProviderId } from './model-adapters/provider-responsiveness.mjs';

const nonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const pick = (value, allowed, fallback = 'unknown') => allowed.includes(value) ? value : fallback;
const intent = value => pick(value, ['queue_next', 'side_question']);
const tokenSource = value => pick(value, ['measured', 'estimated']);
const compactionReasons = ['manual','context_pressure','uncovered_history','unknown_capacity_safety','below_threshold','no_eligible_messages','compression_preservation_budget_exceeded','stale_transcript','session_generation_stale','cancelled','other'];
const authStages = ['configuration','discovery','login','callback','state','token_exchange','jwks','token_validation','authorization','session','logout'];
// Fixed categories only. Never export even sanitized issuer/redirect URLs.
const authReasons = ['auth_internal_error','auth_configuration_missing','basic_credentials_invalid','auth_mode_unsupported','api_token_rejected','trusted_proxy_not_allowed','trusted_proxy_user_missing','oidc_issuer_required','oidc_session_secret_required','oidc_discovery_failed','oidc_discovery_invalid_response','oidc_discovery_issuer_mismatch','oidc_callback_missing_code_or_state','oidc_state_invalid','oidc_provider_access_denied','oidc_provider_login_required','oidc_provider_interaction_required','oidc_provider_consent_required','oidc_provider_server_error','oidc_provider_temporarily_unavailable','oidc_token_exchange_failed','oidc_token_response_invalid','oidc_id_token_missing','oidc_token_issuer_mismatch','oidc_token_audience_mismatch','oidc_token_expired','oidc_token_claim_invalid','oidc_token_signature_invalid','oidc_token_invalid','oidc_jwks_failed','oidc_nonce_invalid','oidc_verified_email_required','oidc_email_not_allowed','oidc_domain_not_allowed','oidc_session_invalid','oidc_session_authorization_changed','oidc_cookie_invalid','oidc_network_timeout','oidc_network_failed','oidc_endpoint_invalid'];

/** Curated operational projection. No independent scheduling/lifecycle decisions. */
export function createOperationalProjection({ tracer, meter, clock, stateForRun }) {
  const counter = name => meter.createCounter(name);
  const histogram = (name, unit = 'ms') => meter.createHistogram(name, { unit });
  const instruments = {
    contextUsage: histogram('burrow.context.usage', '{token}'), contextBudget: histogram('burrow.context.budget', '{token}'), contextRatio: histogram('burrow.context.pressure', '1'),
    compactions: counter('burrow.context.compactions'), compactionDuration: histogram('burrow.context.compaction.duration'), compactionTokens: histogram('burrow.context.compaction.tokens', '{token}'),
    queueWait: histogram('burrow.queue.wait'), interruptions: counter('burrow.run.interruptions'), recoveryAttempts: counter('burrow.recovery.attempts'), recoveryOutcomes: counter('burrow.recovery.outcomes'), recoveryDuration: histogram('burrow.recovery.duration'),
    dbWait: histogram('burrow.database.pool.wait'), dbQuery: histogram('burrow.database.query.duration'),
    dispatch: histogram('burrow.execution.dispatch.duration'), hostTransitions: counter('burrow.execution.host.transitions'), hostDowntime: histogram('burrow.execution.host.downtime'),
    dependencyTransitions: counter('burrow.dependency.transitions'), logins: counter('burrow.auth.logins'), loginDuration: histogram('burrow.auth.login.duration'), callbackFailures: counter('burrow.auth.oidc.callback.failures'), overrides: counter('burrow.auth.environment.activations'),
    recoveryStates: counter('burrow.model.recovery.states'), overdue:counter('burrow.run.drain.transitions'),
  };
  let overdueDrains = 0;
  const overdueTokens = new WeakSet();
  const overdueGauge = meter.createObservableGauge('burrow.runs.drain.overdue', {unit:'{run}'});
  overdueGauge.addCallback(observer => observer.observe(overdueDrains));
  const queues = new Map(), operations = new Map(), waitingParents = new Map();
  const depth = meter.createObservableGauge('burrow.queue.pending', { unit: '{item}' });
  const age = meter.createObservableGauge('burrow.queue.oldest.age', { unit: 'ms' });
  depth.addCallback(observer => { for (const [lane, snapshot] of queues) if (snapshot.depth !== null) observer.observe(snapshot.depth, { 'burrow.queue.intent': lane }); });
  age.addCallback(observer => { for (const [lane, snapshot] of queues) if (snapshot.age !== null) observer.observe(snapshot.age, { 'burrow.queue.intent': lane }); });
  const keyFor = record => JSON.stringify([record.runId || null, record.sessionId || null]);
  const labelsFor = record => {
    const attributes = {};
    for (const [field, name] of [['runId','burrow.run.id'],['sessionId','burrow.session.id']]) {
      const id = configuredProviderId(record[field]);
      if (id) attributes[name] = id;
    }
    return attributes;
  };
  function instant(name, record, labels, durationMs = null, outcome = null) {
    const state = stateForRun(record.runId);
    const end = clock();
    const span = tracer.startSpan(name, { kind: SpanKind.INTERNAL, startTime: end - (nonnegative(durationMs) ?? 0), attributes: { ...labels, ...labelsFor(record) } }, state?.context || context.active());
    if (outcome) span.setStatus({ code: ['success','noop','activated','reconnected','restored','recorded','retired'].includes(outcome) ? SpanStatusCode.OK : SpanStatusCode.ERROR });
    span.end(end);
    return trace.setSpan(state?.context || context.active(), span);
  }
  function startOperation(type, record, labels) {
    const key = `${type}:${keyFor(record)}`;
    if (operations.has(key)) return;
    const parent = stateForRun(record.runId)?.context || context.active();
    const span = tracer.startSpan(`burrow.${type}`, { kind:SpanKind.INTERNAL, attributes:{ ...labels, ...labelsFor(record) } }, parent);
    operations.set(key, { span, context:trace.setSpan(parent, span) });
    if (record.runId && !stateForRun(record.runId)) rememberParent(record.runId, trace.setSpan(parent, span));
  }
  function rememberParent(runId, parent) {
    if (waitingParents.size >= 1024) waitingParents.delete(waitingParents.keys().next().value);
    waitingParents.set(runId, { parent, at: performance.now() });
  }
  function finishOperation(type, record, labels) {
    const key = `${type}:${keyFor(record)}`, entry = operations.get(key);
    if (!entry) { instant(`burrow.${type}`, record, labels, record.durationMs, record.outcome); return; }
    operations.delete(key);
    entry.span.setAttributes(labels);
    entry.span.setStatus({ code:['success','noop'].includes(record.outcome) ? SpanStatusCode.OK : SpanStatusCode.ERROR });
    entry.span.end();
    waitingParents.delete(record.runId);
  }
  function recordTokens(instrument, value, labels) { if (nonnegative(value) !== null) instrument.record(value, labels); }
  function observe(record = {}) {
    const elapsed = nonnegative(record.durationMs);
    if (record.type === 'run-drain-overdue' && ['deadline_exceeded','drained'].includes(record.outcome)) {
      const token = record.operationToken;
      if (!token || typeof token !== 'object') return;
      if (record.outcome === 'deadline_exceeded') { if (overdueTokens.has(token)) return; overdueTokens.add(token); }
      else { if (!overdueTokens.has(token)) return; overdueTokens.delete(token); }
      overdueDrains = Math.max(0,overdueDrains + (record.outcome === 'deadline_exceeded' ? 1 : -1));
      const labels = {'burrow.outcome':record.outcome}; instruments.overdue.add(1,labels);
      instant('burrow.run.drain',record,labels,elapsed,record.outcome === 'drained' ? 'success' : 'failure'); return;
    }
    if (record.type === 'context-pressure') {
      const labels = { 'burrow.context.token_source':tokenSource(record.tokenSource), 'burrow.context.source':pick(record.source,['runtime_receipt','reconstructed','live','persisted']), 'burrow.context.pressure':pick(record.pressure,['ok','watch','compress','blocked']) };
      recordTokens(instruments.contextUsage, record.usageTokens, labels);
      recordTokens(instruments.contextBudget, record.budgetTokens, labels);
      recordTokens(instruments.contextRatio, record.usageRatio, labels);
      const attrs = { ...labels };
      for (const [key, name] of [['usageTokens','usage_tokens'],['budgetTokens','budget_tokens'],['usageRatio','ratio']]) if (nonnegative(record[key]) !== null) attrs[`burrow.context.${name}`] = record[key];
      stateForRun(record.runId)?.span.addEvent('burrow.context.pressure', attrs);
      return;
    }
    if (record.type.startsWith('context-compaction-') || record.type === 'context-compression-skip') {
      const labels = { 'burrow.compaction.trigger':pick(record.trigger,['manual','automatic']), 'burrow.outcome':pick(record.outcome,['started','success','noop','failure','cancelled']), 'burrow.compaction.reason':pick(record.reason,compactionReasons,'other') };
      if (record.type === 'context-compaction-started') { startOperation('context.compaction', record, labels); return; }
      instruments.compactions.add(1,labels);
      if (elapsed !== null) instruments.compactionDuration.record(elapsed,labels);
      const attributes = { ...labels, 'burrow.compaction.token_scope':'conversation' };
      for (const phase of ['before','after']) {
        const source = tokenSource(record[`${phase}TokenSource`]);
        attributes[`burrow.compaction.${phase}_token_source`] = source;
        if (nonnegative(record[`${phase}Tokens`]) !== null) {
          attributes[`burrow.compaction.${phase}_tokens`] = record[`${phase}Tokens`];
          instruments.compactionTokens.record(record[`${phase}Tokens`], { ...labels, 'burrow.compaction.phase':phase, 'burrow.context.token_source':source });
        }
      }
      finishOperation('context.compaction', record, attributes); return;
    }
    if (record.type === 'chat-queue-snapshot') {
      const lane = intent(record.intent); if (lane === 'unknown') return;
      queues.set(lane, { depth:count(record.pendingDepth), age:nonnegative(record.oldestAgeMs) }); return;
    }
    if (record.type === 'chat-queue-started') {
      const labels = { 'burrow.queue.intent':intent(record.intent) };
      if (nonnegative(record.waitMs) !== null) instruments.queueWait.record(record.waitMs, labels);
      const parent = instant('burrow.queue.admission', record, { ...labels, ...(nonnegative(record.waitMs) !== null ? { 'burrow.queue.wait_ms':record.waitMs } : {}) });
      if (record.runId && !stateForRun(record.runId)) rememberParent(record.runId,parent); return;
    }
    if (record.type === 'run-interrupted') {
      const labels = { 'burrow.run.source':pick(record.source,['main','recovery','side_question']), 'burrow.outcome':pick(record.outcome,['requested','recorded','retired','stale','cancelled','failure']), 'burrow.interruption.reason':pick(record.reason,['service_shutdown','queue_owner_lost','queue_owner_shutdown','other'],'other') };
      instruments.interruptions.add(1,labels); instant('burrow.run.interruption', record, labels, elapsed, record.outcome); return;
    }
    if (record.type === 'recovery-attempt' || record.type === 'recovery-completed') {
      const labels = { 'burrow.outcome':pick(record.outcome,['started','success','failure','cancelled','stale','persistence_failure']) };
      const attributes = { ...labels, ...(count(record.attempt) !== null ? { 'burrow.recovery.attempt':record.attempt } : {}) };
      if (record.type === 'recovery-attempt') { instruments.recoveryAttempts.add(1); startOperation('recovery.continuation', record, attributes); }
      else { if (!operations.has(`recovery.continuation:${keyFor(record)}`)) return; instruments.recoveryOutcomes.add(1,labels); if (elapsed !== null) instruments.recoveryDuration.record(elapsed,labels); finishOperation('recovery.continuation',record,attributes); }
      return;
    }
    if (['db-pool-wait','db-query'].includes(record.type)) {
      if (record.dependency !== 'postgresql' || elapsed === null) return;
      (record.type === 'db-pool-wait' ? instruments.dbWait : instruments.dbQuery).record(elapsed,{ 'db.system.name':'postgresql', 'burrow.outcome':pick(record.outcome,['success','failure']) }); return;
    }
    if (record.type === 'dependency-state') {
      if (record.dependency === 'mcp') instruments.dependencyTransitions.add(1,{ 'burrow.dependency':'mcp', 'burrow.outcome':pick(record.outcome,['unavailable','restored']) }); return;
    }
    if (record.type.startsWith('execution-')) {
      if (!['execution-dispatch','execution-host-disconnected','execution-host-reconnected'].includes(record.type)) return;
      const labels = { 'burrow.execution.operation':pick(record.operation,['process','filesystem']), 'burrow.outcome':pick(record.outcome,['success','failure','timeout','cancelled','disconnected','reconnected']) };
      for (const [field,name] of [['providerId','burrow.execution.provider'],['targetId','burrow.execution.host']]) if (configuredProviderId(record[field])) labels[name] = record[field];
      if (record.type === 'execution-dispatch') { if (elapsed !== null) instruments.dispatch.record(elapsed,labels); }
      else { instruments.hostTransitions.add(1,labels); if (record.type === 'execution-host-reconnected' && elapsed !== null) instruments.hostDowntime.record(elapsed,labels); }
      instant(`burrow.${record.type.replaceAll('-','.')}`,record,labels,elapsed,record.outcome); return;
    }
    if (record.type.startsWith('auth-')) {
      const labels = { 'burrow.auth.mode':pick(record.mode,['none','basic','oidc','trusted-proxy']), 'burrow.outcome':pick(record.outcome,['success','failure','activated']) };
      if (record.reason !== undefined) labels['burrow.auth.reason'] = pick(record.reason,authReasons,'auth_internal_error');
      if (record.stage !== undefined) labels['burrow.auth.stage'] = pick(record.stage,authStages);
      if (record.type === 'auth-login') { instruments.logins.add(1,labels); if (elapsed !== null) instruments.loginDuration.record(elapsed,labels); }
      else if (record.type === 'auth-oidc-callback-failed') instruments.callbackFailures.add(1,labels);
      else if (record.type === 'auth-environment-override') instruments.overrides.add(1,labels);
      else return;
      instant(`burrow.${record.type.replaceAll('-','.')}`,record,labels,elapsed,record.outcome);
    }
  }
  return {
    observe,
    parentForRun(runId) {
      const entry = waitingParents.get(runId); waitingParents.delete(runId);
      return entry && performance.now() - entry.at <= 300_000 ? entry.parent : null;
    },
    modelRecovery(record) {
      instruments.recoveryStates.add(1, { 'burrow.model.recovery.state':record.state, ...(record.method ? { 'burrow.model.recovery.method':record.method } : {}) });
    },
    shutdown() {
      for (const { span } of operations.values()) { span.setStatus({code:SpanStatusCode.ERROR,message:'shutdown_before_operation_terminal'}); span.end(); }
      operations.clear(); waitingParents.clear();
      // Observable snapshots must survive the readers' final shutdown collection.
    },
  };
}
