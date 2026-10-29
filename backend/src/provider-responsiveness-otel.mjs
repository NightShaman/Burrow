import { trace, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { configuredProviderId, configuredProviderName, providerUsageValues, capturedProviderUsage } from './model-adapters/provider-responsiveness.mjs';

const outcomes = new Set(['success', 'failure', 'cancelled', 'timeout']);
const categories = new Set(['unknown', 'timeout', 'cancelled', 'rate_limited', 'authentication', 'permission', 'provider_5xx', 'provider_4xx', 'local', 'transport', 'provider_generation']);
const kinds = new Set(['text', 'thought', 'tool']);
const duration = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const count = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const status = value => Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;
const outcome = payload => payload.timedOut === true || ['timeout','timed_out','timedOut'].includes(payload.status) ? 'timeout'
  : payload.cancelled === true || payload.status === 'cancelled' ? 'cancelled'
  : outcomes.has(payload.outcome) ? payload.outcome
  : payload.outcome === 'failed' || payload.ok === false || ['failed','failure','error'].includes(payload.status) ? 'failure'
  : payload.ok === true || ['completed','success','succeeded'].includes(payload.status) ? 'success' : 'failure';

function identity(payload, { pool = false, account = false, names = false } = {}) {
  const attributes = {};
  for (const [key, name] of [['provider', 'gen_ai.provider.name'], ['api', 'burrow.model.api'], ['model', 'gen_ai.request.model']]) {
    const value = configuredProviderId(payload[key]);
    if (value) attributes[name] = value;
  }
  if (pool && configuredProviderId(payload.poolId)) attributes['burrow.pool.id'] = payload.poolId;
  if (account && configuredProviderId(payload.accountId || payload.memberId)) attributes['burrow.account.id'] = payload.accountId || payload.memberId;
  if (names) for (const [key, name] of [['poolName', 'burrow.pool.name'], ['accountName', 'burrow.account.name']]) {
    const value = configuredProviderName(payload[key]);
    if (value) attributes[name] = value;
  }
  return attributes;
}

// Consumes only the persisted producer->observer stream. No provider payload,
// URL, headers, error prose, thread key, or arbitrary diagnostics are copied.
// Request/attempt/run identities are trace-only; labels come from configured
// model/account/pool identities and fixed enums. Cached input is a subset of
// input, not additional input or total tokens.
export function createProviderResponsivenessProjection({ tracer, instruments, clock, tokenCount, onContext = null }) {
  const runs = new WeakMap();
  function data(state) {
    let value = runs.get(state);
    if (!value) { value = { pools: new Map(), donePools: new Set(), doneRequests: new Set(), doneAttempts: new Set(), doneCooldowns: new Set() }; runs.set(state, value); }
    return value;
  }
  function terminal(span, payload, endTime = undefined) {
    const result = outcome(payload);
    span.setAttribute('burrow.outcome', result);
    if (status(payload.status) !== null) span.setAttribute('http.response.status_code', payload.status);
    if (categories.has(payload.failureCategory)) span.setAttribute('burrow.failure.category', payload.failureCategory);
    span.setStatus({ code: result === 'success' ? SpanStatusCode.OK : SpanStatusCode.ERROR,
      ...(result !== 'success' ? { message: result === 'failure' ? 'model_request_failed' : result } : {}) });
    span.end(endTime);
  }
  function openPhysical(state, entry, payload = {}) {
    if (entry.span) return;
    const pool = data(state).pools.get(String(entry.poolRequestId || ''));
    let parent = pool?.context || state.context;
    const observedStart = Date.parse(payload.invokedAt || payload.observedAt);
    entry.spanStart = Number.isFinite(observedStart) ? observedStart : clock();
    if (pool && count(payload.attempt) > 0) {
      entry.attempt = payload.attempt;
      entry.attemptSpan = tracer.startSpan('burrow.provider_pool.attempt', { kind: SpanKind.INTERNAL, startTime:entry.spanStart, attributes: {
        ...entry.attributes, 'burrow.pool.request.id': entry.poolRequestId,
        'burrow.provider.attempt': entry.attempt, 'burrow.model.request.id': entry.requestId,
      } }, parent);
      parent = trace.setSpan(parent, entry.attemptSpan);
    }
    entry.span = tracer.startSpan('burrow.model.request', { kind: SpanKind.CLIENT, startTime:entry.spanStart, attributes: {
      ...entry.attributes, 'burrow.model.request.id': entry.requestId,
      ...(entry.poolRequestId ? { 'burrow.pool.request.id': entry.poolRequestId } : {}),
      ...(entry.attempt ? { 'burrow.provider.attempt': entry.attempt } : {}),
    } }, parent);
  }
  function finishPhysical(state, entry, completion) {
    if (!entry.span) return;
    const result = outcome(completion);
    const response = completion.result || entry.response || {};
    if (response.contextUsage) {
      const measured = response.contextUsage.source === 'provider-input-tokens';
      const usageTokens = duration(response.contextUsage.estimatedTokens), budgetTokens = duration(response.contextBudgetTokens);
      const ratio = usageTokens !== null && budgetTokens > 0 ? usageTokens / budgetTokens : null;
      onContext?.({ type:'context-pressure', runId:state.runId, usageTokens, budgetTokens:budgetTokens > 0 ? budgetTokens : null, usageRatio:ratio, source:'live', tokenSource:measured ? 'measured' : 'estimated', pressure:ratio === null ? 'unknown' : ratio >= 1 ? 'blocked' : ratio >= 0.9 ? 'compress' : ratio >= 0.75 ? 'watch' : 'ok' });
    }
    const labels = { ...entry.labels, 'burrow.outcome': result,
      ...(categories.has(completion.failureCategory) ? { 'burrow.failure.category':completion.failureCategory } : {}) };
    const normalized = response.normalizedUsage ? capturedProviderUsage(response.normalizedUsage)
      : providerUsageValues(response.usage, { provider:response.provider || entry.attributes['gen_ai.provider.name'], api:response.api || entry.attributes['burrow.model.api'] });
    const { cached:normalizedCached, ...usage } = normalized;
    const cached = response.normalizedUsage ? normalizedCached : Object.hasOwn(response, 'cachedTokens') ? tokenCount(response.cachedTokens) : normalizedCached;
    for (const [kind, value] of Object.entries(usage)) if (value !== null) entry.span.setAttribute(`gen_ai.usage.${kind}_tokens`, value);
    if (cached !== null) entry.span.setAttribute('gen_ai.usage.cache_read.input_tokens', cached);
    const elapsed = duration(completion.durationMs) ?? (!entry.timed ? Math.max(0, clock() - entry.startedAt) : null);
    if (elapsed !== null) {
      entry.span.setAttribute('burrow.provider.duration_ms', elapsed);
      instruments.modelDuration.record(elapsed, labels);
    }
    instruments.models.add(1, labels);
    for (const [kind, value] of Object.entries(usage)) if (value !== null) instruments.tokens.add(value, { ...labels, 'burrow.token.kind': kind });
    if (cached !== null) instruments.tokens.add(cached, { ...labels, 'burrow.token.kind': 'cached' });
    for (const [kind, value] of entry.firstDeltas) {
      entry.span.setAttribute(`burrow.provider.first_${kind}_ms`, value);
      entry.attemptSpan?.setAttribute(`burrow.provider.first_${kind}_ms`, value);
      instruments.modelFirstDelta.record(value, { ...labels, 'burrow.stream.kind': kind });
    }
    if (entry.ttft !== undefined) {
      entry.span.setAttribute('burrow.provider.ttft_ms', entry.ttft);
      entry.attemptSpan?.setAttribute('burrow.provider.ttft_ms', entry.ttft);
      instruments.modelTTFT.record(entry.ttft, labels);
    }
    if (entry.attemptSpan) {
      const poolLabels = labels;
      instruments.poolAttempts.add(1, poolLabels);
      if (elapsed !== null) { instruments.poolAttemptDuration.record(elapsed, poolLabels); entry.attemptSpan.setAttribute('burrow.provider.duration_ms', elapsed); }
      if (entry.ttft !== undefined) instruments.poolTTFT.record(entry.ttft, poolLabels);
      terminal(entry.attemptSpan, completion, elapsed === null ? undefined : entry.spanStart + elapsed);
    }
    terminal(entry.span, completion, elapsed === null ? undefined : entry.spanStart + elapsed);
    state.modelSpans.delete(entry.requestId);
    data(state).doneRequests.add(entry.requestId);
  }
  function observe(record, state) {
    const payload = record.payload || {}, run = data(state), key = String(payload.requestId || '');
    if (record.type === 'model' && payload.stage === 'provider-pool-request' && key) {
      if (run.pools.has(key) || run.donePools.has(key)) return true;
      const attributes = identity(payload, { pool:true, names:true });
      const span = tracer.startSpan('burrow.provider_pool.request', { kind: SpanKind.INTERNAL,
        attributes: { ...attributes, 'burrow.pool.request.id': key } }, state.context);
      run.pools.set(key, { span, context:trace.setSpan(state.context, span), attributes });
      return true;
    }
    if (record.type === 'model' && payload.stage === 'provider-pool-selection') {
      run.pools.get(key)?.span.addEvent('burrow.provider_pool.selection', identity({ ...payload, accountId:payload.servingConnectionId }, { pool:true, account:true, names:true }));
      return true;
    }
    if (record.type === 'model' && payload.stage === 'provider-pool-attempt') {
      // This existing stage owns the dedicated LB token subset only. Physical
      // completion owns attempt counts/duration/TTFT, never a second generic
      // request/token emission. Preserve old custom-adapter token producers.
      if (key && count(payload.attempt) > 0) {
        const receipt = JSON.stringify([key,payload.attempt]);
        if (run.doneAttempts.has(receipt)) return true;
        run.doneAttempts.add(receipt);
      }
      const labels = { ...identity(payload, { pool:true, account:true }), 'burrow.outcome':outcome(payload) };
      for (const [kind, name] of [['input','inputTokens'], ['output','outputTokens'], ['cached','cachedTokens']]) {
        if (count(payload[name]) !== null) instruments.poolTokens.add(payload[name], { ...labels, 'burrow.token.kind':kind });
      }
      return true;
    }
    if (record.type === 'model' && payload.stage === 'provider-pool-outcome') {
      if (key && run.donePools.has(key)) return true;
      if (key) run.donePools.add(key);
      const labels = { ...identity(payload, { pool:true, account:true }), 'burrow.outcome':outcome(payload) };
      instruments.poolRequests.add(1, labels);
      if (duration(payload.durationMs) !== null) instruments.poolDuration.record(payload.durationMs, labels);
      if (duration(payload.ttftMs) !== null) instruments.poolRequestTTFT.record(payload.ttftMs, labels);
      if (count(payload.attempts) !== null && payload.attempts > 1) instruments.poolRetries.add(payload.attempts - 1, labels);
      if (count(payload.failovers) > 0) instruments.poolFailovers.add(payload.failovers, labels);
      const entry = run.pools.get(key);
      if (entry) {
        entry.span.setAttributes(identity(payload, { pool:true, account:true, names:true }));
        if (duration(payload.durationMs) !== null) entry.span.setAttribute('burrow.provider.duration_ms', payload.durationMs);
        if (count(payload.attempts) !== null) entry.span.setAttribute('burrow.provider.attempts', payload.attempts);
        if (count(payload.failovers) !== null) entry.span.setAttribute('burrow.provider.failovers',payload.failovers);
        if (duration(payload.ttftMs) !== null) entry.span.setAttribute('burrow.provider.ttft_ms',payload.ttftMs);
        terminal(entry.span, payload); run.pools.delete(key);
      }
      return true;
    }
    if (record.type === 'model' && payload.stage === 'provider-pool-cooldown') {
      const transitions = ['persisted','entered','extended','unchanged'], reasons = ['transport','rate_limited','authentication','provider_failure'];
      if (!transitions.includes(payload.transition) || !reasons.includes(payload.reason) || duration(payload.durationMs) === null || payload.boundary !== 'persisted-health-window') return true;
      if (key && duration(payload.updatedAtMs) !== null && duration(payload.cooldownUntilMs) !== null) {
        const receipt = JSON.stringify([key,payload.memberId,payload.updatedAtMs,payload.cooldownUntilMs]);
        if (run.doneCooldowns.has(receipt)) return true;
        run.doneCooldowns.add(receipt);
      }
      const labels = { ...identity(payload, { pool:true, account:true }), 'burrow.cooldown.transition':payload.transition, 'burrow.cooldown.reason':payload.reason };
      instruments.poolCooldownTransitions.add(1, labels);
      instruments.poolCooldownDuration.record(payload.durationMs, labels);
      run.pools.get(key)?.span.addEvent('burrow.provider_pool.cooldown', { ...labels, 'burrow.cooldown.duration_ms':payload.durationMs, 'burrow.cooldown.boundary':'persisted-health-window' });
      return true;
    }
    if (record.type === 'model' && payload.stage === 'model-request' && key) {
      if (state.modelSpans.has(key) || run.doneRequests.has(key)) return true;
      const attributes = identity(payload, { pool:true, account:true, names:true });
      const labels = identity(payload, { pool:true, account:true });
      // API is bounded configuration but not necessary on generic metric series.
      delete labels['burrow.model.api'];
      labels['gen_ai.provider.name'] ||= 'unknown'; labels['gen_ai.request.model'] ||= 'unknown';
      const entry = { requestId:key, attributes, labels, startedAt:clock(), timed:payload.providerTiming === true,
        poolRequestId:typeof payload.poolRequestId === 'string' ? payload.poolRequestId : null, span:null, firstDeltas:new Map() };
      state.modelSpans.set(key, entry);
      if (!entry.timed) openPhysical(state, entry);
      return true;
    }
    if (record.type === 'model' && payload.stage === 'model-response' && key) {
      const entry = state.modelSpans.get(key);
      if (!entry) return true;
      entry.response = payload;
      if (!entry.timed) finishPhysical(state, entry, payload);
      return true;
    }
    if (['provider-dispatched','provider-response-headers','provider-first-content','provider-completed'].includes(record.type)) {
      const entry = state.modelSpans.get(key);
      if (!entry?.timed) return true;
      if (record.type === 'provider-dispatched') {
        if (payload.boundary === 'local-fetch-invocation' && payload.clockDomain === 'server-process') {
          openPhysical(state, entry, payload);
          if (entry.headerStatus !== undefined) entry.span.setAttribute('http.response.status_code', entry.headerStatus);
          if (entry.completion) finishPhysical(state, entry, entry.completion);
        }
      } else if (record.type === 'provider-first-content') {
        if (kinds.has(payload.kind) && duration(payload.ttftMs) !== null && payload.boundary === 'parsed-stream-content' && !entry.firstDeltas.has(payload.kind)) {
          entry.firstDeltas.set(payload.kind, payload.ttftMs);
          if (payload.first === true && entry.ttft === undefined) entry.ttft = payload.ttftMs;
        }
      } else if (record.type === 'provider-response-headers') {
        if (status(payload.status) !== null) { entry.headerStatus = payload.status; entry.span?.setAttribute('http.response.status_code', payload.status); }
      } else {
        // Deferred persistence may finish out of scheduling order. Completion
        // can precede its dispatch receipt; retain until that exact dispatch
        // arrives instead of losing the request or inventing a new start.
        entry.completion = payload;
        finishPhysical(state, entry, payload);
      }
      return true;
    }
    return false;
  }
  function endRun(state) {
    const run = runs.get(state);
    // Missing terminals stay explicitly incomplete: do not manufacture a
    // successful outcome, attempt count, duration, or TTFT for them.
    for (const entry of state.modelSpans.values()) for (const span of [entry.span, entry.attemptSpan]) {
      span?.setStatus({ code:SpanStatusCode.ERROR, message:'run_ended_before_child_span' }); span?.end();
    }
    state.modelSpans.clear();
    for (const entry of run?.pools.values() || []) {
      entry.span.setStatus({ code:SpanStatusCode.ERROR, message:'run_ended_before_child_span' }); entry.span.end();
    }
    runs.delete(state);
  }
  return { observe, endRun };
}
