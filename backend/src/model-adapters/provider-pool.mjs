import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { withProviderRoute, deferProviderDiagnostic, providerObservation } from './provider-fetch.mjs';
import { providerIdentity, providerCompletion, configuredProviderName, providerUsageValues, capturedProviderUsage } from './provider-responsiveness.mjs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { classifyModelFailure, markModelInternalError, modelFailureResult, retainModelFailure } from '../model-failure.mjs';
import { poolAttemptUsage } from '../postgres-provider-pool-metrics.mjs';
import { portablePoolReplay } from './pool-replay.mjs';
import { ProviderPoolEngine, poolThreadKey, AFFINITY_CACHE_TTL_MS } from '../provider-pool-engine.mjs';

// Only protocol guard codes may cross the diagnostic boundary; unexpected
// replay exceptions can contain message bodies, credentials or internal data.
const REPLAY_GUARD_CODES = new Set(['provider_pool_replay_incomplete_history', 'provider_pool_replay_nonportable_history']);
const INTERNAL_DIAGNOSTIC_CODE = 'provider_diagnostic_persistence_failed';
function replayBlockDiagnostic(error) {
  let code;
  try { code = error?.message; } catch { /* Never expose exception text. */ }
  return { code: REPLAY_GUARD_CODES.has(code) ? code : 'provider_pool_replay_unavailable', action: 'blocked' };
}

function routedReceipt(result, route, diagnostic = null) {
  const receipt = { ...result, providerPool: { ...route, ...(diagnostic ? { failover: diagnostic } : {}) }, nativeTranscriptComplete: false };
  // modelFailureResult retains these properties non-enumerably. Do not lose the
  // actual provider or callback exception when copying a receipt to add route.
  for (const key of ['cause', 'originalResult']) {
    if (result && Object.hasOwn(result, key)) Object.defineProperty(receipt, key, { value: result[key] });
  }
  return receipt;
}

function preserveOriginalFailure(failure, route, diagnostic) {
  const providerPool = { ...route, failover: diagnostic };
  if (failure instanceof Error) {
    // Keep the original error identity, including for callers that supplied a
    // frozen error. Attach provenance only when doing so is safe.
    try { Object.defineProperty(failure, 'providerPool', { value: providerPool, configurable: true, enumerable: true }); } catch {}
    throw failure;
  }
  return routedReceipt(failure, route, diagnostic);
}

function retainSecondary(error, result) {
  return retainModelFailure(markModelInternalError(error, INTERNAL_DIAGNOSTIC_CODE), result);
}

export function createProviderPoolModelAdapter(options, createMemberAdapter) {
  const config = options.config || {};
  const pool = options.providerPool || config.providerPool;
  if (typeof pool?.resolveMember !== 'function') throw new Error('provider_pool_member_resolver_required');
  const engine = pool.engine || new ProviderPoolEngine(pool);
  const family = pool.connection.apiType === 'anthropic-lb' ? 'anthropic' : 'openai';
  // Estimation is synchronous and credential-free. No asynchronous selection is
  // smuggled into estimateRequest or static capability properties.
  const logical = createMemberAdapter({ ...options, providerPool: null, config: { ...config, providerPool: null,
    api: family === 'anthropic' ? 'anthropic-messages' : 'openai-responses', apiType: family === 'anthropic' ? 'anthropic-messages' : 'openai-responses' } });
  const adapters = new Map();
  const now = pool.clock || Date.now;
  const fetchAttempts = new AsyncLocalStorage();
  const fetchImpl = options.fetchImpl === undefined ? globalThis.fetch : options.fetchImpl;
  const memberFetch = fetchImpl && (async (...fetchArgs) => {
    const state = fetchAttempts.getStore();
    // This wrapper is entered only AFTER the shared provider-fetch gate grants
    // dispatch. A denied gate is not a physical attempt or a pool measurement.
    const dispatch = state ? { started: now(), monotonicStarted: performance.now(), ordinal: ++state.metric.attempts } : null;
    if (dispatch) state.route.attempt = dispatch.ordinal;
    if (dispatch) state.dispatches.push(dispatch);
    try {
      const response = await fetchImpl(...fetchArgs);
      if (dispatch) dispatch.status = response?.status;
      return response;
    } catch (error) {
      if (state) state.fetchError = error;
      if (dispatch) dispatch.error = error;
      throw error;
    }
  });
  const getAdapter = async (memberId, threadKey, fresh = false) => {
    const key = JSON.stringify([threadKey, memberId]);
    const cached = adapters.get(key);
    const resolved = await pool.resolveMember(memberId);
    const memberConfig = resolved?.model && typeof resolved.model === 'object' ? resolved.model : resolved;
    if (!memberConfig || memberConfig.providerPool || /-lb$/.test(memberConfig.api || memberConfig.apiType || '')) throw new Error('provider_pool_invalid_member_config');
    if (!fresh && cached && cached.authToken === memberConfig.apiKey && now() - cached.usedAt < AFFINITY_CACHE_TTL_MS) { cached.usedAt = now(); return { adapter: cached.adapter, identity: providerIdentity(memberConfig) }; }
    const adapter = createMemberAdapter({ ...options, fetchImpl: memberFetch, providerPool: null, config: { ...memberConfig, model: config.model, temperature: config.temperature, maxTokens: config.maxTokens, extra: config.extra, reasoningEffort: config.reasoningEffort, codexSessionId: threadKey, codexThreadId: threadKey, providerPool: null } });
    // Native turn-state is isolated by both thread AND account, never copied.
    for (const [oldKey, value] of adapters) if (now() - value.usedAt >= AFFINITY_CACHE_TTL_MS) adapters.delete(oldKey);
    if (adapters.size >= 1000) adapters.delete(adapters.keys().next().value);
    adapters.set(key, { adapter, authToken: memberConfig.apiKey, usedAt: now() });
    return { adapter, identity: providerIdentity(memberConfig) };
  };
  const metrics = family === 'openai' ? pool.store?.providerPoolMetrics : null;
  // A distinct key per pool adapter avoids conflating different adapters sharing
  // a logical recovery context. The value in finalizers is the one finalizer.
  const metricKey = {};
  // The helper re-enters this same adapter with the same logical context. Keep
  // the last upstream receipt in-memory so failures before an outer retry's
  // dispatch (selection/resolution/trace) cannot replace or hide that receipt.
  const managedFailures = new WeakMap();
  const priorManagedFailure = args => args.recoveryContext && managedFailures.get(args.recoveryContext);
  const invokeInner = async (method, args = {}, metric = null) => {
    const previousRoute = args.previousModel?.providerPool;
    const recoveryRoute = args.recoveryContext ? args.recoveryRoute : null;
    let continuation = method !== 'complete' || Boolean(args.toolContinuation);
    // Complete() can also be given opaque signed Anthropic history. Without
    // explicit route provenance it is not portable between OAuth accounts.
    const history = [...(args.messages || []), ...(args.preparedMessages || []), ...(args.baseMessages || [])];
    const signedHistory = history.some((message) => Array.isArray(message?.content)
      && message.content.some((part) => part?.type === 'thinking' || part?.type === 'redacted_thinking'));
    const nativeHistory = signedHistory || history.some(message => ['function_call', 'function_call_output'].includes(message?.type));
    if (nativeHistory && !previousRoute?.servingConnectionId) throw new Error('provider_pool_signed_history_owner_missing');
    if (nativeHistory) continuation = true;
    const initialRequest = Array.isArray(args.messages) ? args.messages :
      args.prompt != null ? [{ role: 'user', content: args.prompt }] : [];
    const protocolHistory = initialRequest.some(message => message?.role === 'tool' ||
      ['function_call', 'function_call_output'].includes(message?.type) ||
      Array.isArray(message?.tool_calls) && message.tool_calls.length ||
      Array.isArray(message?.content) && message.content.some(part =>
        ['tool_use', 'tool_result', 'thinking', 'redacted_thinking'].includes(part?.type)));
    const freshRequest = method === 'complete' && !continuation && !previousRoute && !protocolHistory;
    if (continuation && (!previousRoute?.servingConnectionId || previousRoute.logicalConnectionId !== pool.connection.id)) {
      throw new Error('provider_pool_continuation_owner_missing');
    }
    const replay = continuation && method === 'continueWithToolResults' ? (() => {
      try { return portablePoolReplay(args, family); } catch (error) {
        // Ordinary owner-pinned continuation remains available. Portability
        // failures only veto switching; the original account may still serve.
        return { error };
      }
    })() : null;
    const threadKey = previousRoute?.threadKey || recoveryRoute?.threadKey || poolThreadKey(args);
    const excluded = [];
    let originalFailure, originalReceipt, originalRoute;
    for (let attempt = 0; attempt < 2; attempt++) {
      args.signal?.throwIfAborted();
      const canReplay = Boolean(replay && !replay.error);
      // A failed alternate is not the owner of previousModel. It may only see
      // the scrubbed portable replay, never the previous owner's native state.
      const recoveringAlternate = continuation && canReplay && !attempt && recoveryRoute?.servingConnectionId
        && recoveryRoute.servingConnectionId !== previousRoute.servingConnectionId;
      const requiredMemberId = continuation && !(attempt && canReplay)
        ? (recoveringAlternate ? recoveryRoute.servingConnectionId : previousRoute.servingConnectionId) : null;
      let selection;
      try { selection = await engine.select({ threadKey, model: config.model, exclude: excluded, requiredMemberId }); }
      catch (error) {
        if (!originalFailure) {
          const prior = priorManagedFailure(args);
          if (prior && !args.signal?.aborted) throw retainSecondary(error, prior);
          throw error;
        }
        const diagnostic = { code: 'provider_pool_alternate_selection_failed', action: 'blocked' };
        if (!args.recoveryContext) return preserveOriginalFailure(originalFailure, originalRoute, diagnostic);
        throw retainSecondary(error, routedReceipt(originalReceipt, originalRoute, diagnostic));
      }
      const useReplay = continuation && canReplay && selection.memberId !== previousRoute.servingConnectionId;
      let adapter, identity;
      try { ({ adapter, identity } = await getAdapter(selection.memberId, threadKey, attempt > 0 || useReplay)); }
      catch (error) {
        if (!originalFailure) {
          const prior = priorManagedFailure(args);
          if (prior && !args.signal?.aborted) throw retainSecondary(error, prior);
          throw error;
        }
        const diagnostic = { code: 'provider_pool_alternate_resolution_failed', action: 'blocked' };
        if (!args.recoveryContext) return preserveOriginalFailure(originalFailure, originalRoute, diagnostic);
        throw retainSecondary(error, routedReceipt(originalReceipt, originalRoute, diagnostic));
      }
      let visible = false;
      let callbackFailed = false;
      let callbackInvoked = false;
      const callArgs = { ...(useReplay ? replay : args) };
      metric.accountNames.set(selection.memberId, identity.accountName);
      const telemetryRoute = { poolId: pool.connection.id, poolName: configuredProviderName(pool.connection.provider), poolRequestId: metric.id, accountId: selection.memberId, accountName: identity.accountName };
      const fetchState = { metric, route: telemetryRoute, dispatches: [], gateError: null };
      telemetryRoute.observe = (type, payload) => {
        if (type === 'provider-dispatched') {
          const dispatch = fetchState.dispatches.at(-1);
          if (dispatch) {
            dispatch.providerRequestId = payload.requestId;
            if (metric.lastAccountId && metric.lastAccountId !== selection.memberId) metric.failovers++;
            metric.lastAccountId = selection.memberId;
          }
        } else if (type === 'provider-first-content' && payload.first === true && metric.ttftMs === undefined) {
          metric.ttftMs = Math.max(0, payload.monotonicMs - metric.monotonicStarted);
        } else if (type === 'provider-completed') {
          const dispatch = fetchState.dispatches.find(entry => entry.providerRequestId === payload.requestId);
          if (dispatch) dispatch.durationMs = payload.durationMs;
        }
      };
      telemetryRoute.complete = (requestId, value, durable = {}) => {
        const dispatch = fetchState.dispatches.find(entry => entry.providerRequestId === requestId);
        if (dispatch) { dispatch.result = value; dispatch.hasResult = true; dispatch.durable = durable; }
      };
      if (args.recoveryContext?.beforeDispatch) {
        callArgs.recoveryContext = { ...args.recoveryContext, beforeDispatch: async () => {
          try { return await args.recoveryContext.beforeDispatch(); }
          catch (error) { fetchState.gateError = error; throw error; }
        } };
      }
      for (const name of ['onTextDelta', 'onThoughtDelta', 'onContextUsage']) {
        if (typeof args[name] !== 'function') continue;
        callArgs[name] = async (...values) => {
          if (name !== 'onContextUsage') callbackInvoked = true;
          if (name !== 'onContextUsage') visible = true;
          try { return await args[name](...values); } catch (error) { callbackFailed = true; throw error; }
        };
      }
      const route = { logicalConnectionId: pool.connection.id, servingConnectionId: selection.memberId,
        ownerConnectionId: selection.ownerId, threadKey, substitute: selection.substitute, attempt: attempt + 1,
        diagnostics: selection.diagnostics, rebalanceReason: selection.rebalanceReason || null };
      try { await args.traceLogger?.model?.({ stage: 'provider-pool-selection', ...route, poolId: pool.connection.id, requestId: metric.id, accountName: identity.accountName, model: config.model }); }
      catch (error) {
        if (originalReceipt) throw retainSecondary(error, routedReceipt(originalReceipt, originalRoute));
        const prior = priorManagedFailure(args);
        if (prior && !args.signal?.aborted) throw retainSecondary(error, prior);
        throw markModelInternalError(error, INTERNAL_DIAGNOSTIC_CODE);
      }
      const attemptStarted = now();
      let result, caughtError;
      try { result = await withProviderRoute(telemetryRoute, () => fetchAttempts.run(fetchState, () => adapter[method](callArgs))); }
      catch (error) {
        caughtError = error;
        // Capture *inside the failure scope* before metrics/trace/cooldown can
        // overwrite provenance, even if a logger reuses the same Error object.
        result = modelFailureResult(error, { signal: args.signal });
      }
      const receipt = routedReceipt(result, route);
      const capture = async () => {
        // Preserve direct callers using custom member adapters that don't use
        // provider-fetch; managed real members are counted only at fetch.
        const dispatches = fetchState.dispatches.length ? fetchState.dispatches
          : !args.recoveryContext && !adapter.url ? [{ started: attemptStarted, ordinal: ++metric.attempts }] : [];
        for (let index = 0; index < dispatches.length; index++) {
          const dispatch = dispatches[index], last = index === dispatches.length - 1;
          const measured = dispatch.hasResult ? dispatch.result : last ? result : null;
          const error = dispatch.error || (!dispatch.hasResult && last ? caughtError : null);
          const status = measured?.status ?? dispatch.status;
          const success = measured ? measured.ok : !error && status >= 200 && status < 300;
          const completion = dispatch.hasResult ? { outcome:measured.outcome, ...(status !== undefined ? { status } : {}),
            ...(measured.failureCategory ? { failureCategory:measured.failureCategory } : {}) }
            : providerCompletion(measured || { ok:success }, { error, signal:args.signal, observedStatus:dispatch.status ?? (error && !measured?.requestId ? null : status) });
          const normalized = measured?.normalizedUsage ? capturedProviderUsage(measured.normalizedUsage)
            : family === 'anthropic' ? providerUsageValues(measured?.usage, { provider:family }) : null;
          const measurement = { attempt: dispatch.ordinal, memberId: selection.memberId,
            providerRequestId: dispatch.providerRequestId || measured?.requestId, durationMs: dispatch.durationMs ?? Math.max(0, dispatch.monotonicStarted === undefined ? now() - dispatch.started : performance.now() - dispatch.monotonicStarted),
            outcome: (dispatch.hasResult ? dispatch.durable?.cancelled : args.signal?.aborted || error?.name === 'AbortError') ? 'cancelled' : success ? 'success' : 'failed',
            status, errorKind: dispatch.hasResult ? dispatch.durable?.errorKind ?? null : success ? null : error && !measured?.status ? (args.signal?.aborted ? 'cancelled' : 'exception') : 'provider_failure',
            ...(metrics && dispatch.hasResult ? dispatch.durable.usage : normalized ? { inputTokens:normalized.input, outputTokens:normalized.output, cachedTokens:normalized.cached } : poolAttemptUsage(measured?.usage)) };
          await metrics?.attempt(metric.id, measurement);
          const attemptRecord = {stage:'provider-pool-attempt',requestId:metric.id,
            poolId:pool.connection.id,model:config.model,accountName:identity.accountName,...measurement, ...completion};
          if (metrics) await args.traceLogger?.model?.(attemptRecord); // Existing OpenAI durable path.
          else deferProviderDiagnostic(args.traceLogger, () => providerObservation(args.traceLogger,'model',attemptRecord), { optional:true });
        }
      };
      try { await capture(); } catch (error) {
        // If this alternate never crossed the dispatch boundary, it has no
        // provider receipt of its own: retain the actual prior result.
        const measuredReceipt = fetchState.dispatches.length ? receipt
          : originalReceipt ? routedReceipt(originalReceipt, originalRoute) : priorManagedFailure(args) || receipt;
        throw retainSecondary(error, measuredReceipt);
      }

      if (caughtError) {
        // A nested pool retry or provider repair may reach an already exhausted
        // gate. It never dispatched: return the real earlier receipt instead.
        if (fetchState.gateError === caughtError && caughtError?.message === 'model_recovery_attempts_exhausted') {
          // A real receipt obtained *during* this member call (for example a
          // provider's signed-history repair) is newer than the previous pool
          // attempt; never mask it with a gate error or an older receipt.
          if (result.originalResult?.ok === false) {
            const { recoveryFailure: _recoveryFailure, ...realFailure } = result;
            return routedReceipt(realFailure, route);
          }
          if (originalReceipt) return routedReceipt(originalReceipt, originalRoute);
          const prior = priorManagedFailure(args);
          if (prior) return prior;
        }
        // An adapter may throw a local diagnostics failure after receiving a
        // provider response. That receipt and recoveryFailure are decisive.
        if (result.recoveryFailure) {
          if (args.recoveryContext) return receipt;
          throw retainModelFailure(caughtError, receipt);
        }
        // Fetch or response-read provenance must be proven at the actual
        // provider boundary; bare TypeErrors and callback errors prove nothing.
        const failure = classifyModelFailure(caughtError, { signal: args.signal });
        if (originalReceipt && args.recoveryContext && !args.signal?.aborted && failure.origin !== 'upstream') {
          return { ...routedReceipt(originalReceipt, originalRoute), recoveryFailure: failure };
        }
        const prior = priorManagedFailure(args);
        if (!fetchState.dispatches.length && prior && args.recoveryContext && !args.signal?.aborted && failure.origin !== 'upstream') {
          return { ...prior, recoveryFailure: failure };
        }
        const transportFailure = failure.origin === 'upstream' && failure.retryable &&
          ((failure.code === 'provider_transport_failed' && fetchState.fetchError === caughtError) || failure.code === 'provider_read_failed');
        if (transportFailure && continuation && replay?.error && !callbackFailed && !callbackInvoked && !visible && !args.signal?.aborted && attempt === 0) {
          if (args.recoveryContext) return routedReceipt(result, route, replayBlockDiagnostic(replay.error));
          return preserveOriginalFailure(caughtError, route, replayBlockDiagnostic(replay.error));
        }
        if (callbackFailed || callbackInvoked || visible || (continuation && (!replay || replay.error)) || args.signal?.aborted || !transportFailure || attempt > 0) {
          if (args.recoveryContext) return receipt;
          throw caughtError;
        }
        originalFailure = caughtError; originalReceipt = result; originalRoute = route;
        try { await cooldown(selection.memberId, 'transport_unavailable', args, metric); }
        catch (error) { throw retainSecondary(error, receipt); }
        excluded.push(selection.memberId);
        continue;
      }
      // A secondary fault can never authorize another dispatch, even when the
      // preserved provider receipt was an otherwise retryable HTTP status.
      if (result.recoveryFailure) return receipt;
      const retryable = !result.ok && ([401, 403, 429].includes(Number(result.status)) || (Number(result.status) >= 500 && Number(result.status) <= 599));
      if (retryable) {
        try { await cooldown(selection.memberId, `http_${result.status}`, args, metric); }
        catch (error) { throw retainSecondary(error, receipt); }
      }
      if (retryable && continuation && replay?.error && !callbackInvoked && !visible && !args.signal?.aborted && attempt === 0 && !result.choice?.text && !result.choice?.toolCalls?.length) {
        return preserveOriginalFailure(result, route, replayBlockDiagnostic(replay.error));
      }
      if (retryable && !callbackInvoked && !visible && (!continuation || canReplay) && !args.signal?.aborted && attempt === 0
        && !result.choice?.text && !result.choice?.toolCalls?.length) {
        originalFailure = result; originalReceipt = result; originalRoute = route;
        excluded.push(selection.memberId);
        continue;
      }
      if (result.ok && (selection.rebalanceReason || useReplay) && typeof engine.promote === 'function') {
        try {
          const promoted = await engine.promote({ threadKey, memberId: selection.memberId, previousOwnerId: selection.rebalanceReason ? selection.ownerId : (originalRoute?.ownerConnectionId || previousRoute?.ownerConnectionId) });
          if (promoted) { route.ownerConnectionId = selection.memberId; route.substitute = false; }
        } catch (error) { throw retainSecondary(error, routedReceipt(result, route)); }
      }
      return { ...result, providerPool: route, nativeTranscriptComplete: result.ok === true &&
        (continuation ? canReplay : freshRequest) };
    }
    throw new Error('provider_pool_retry_exhausted');
  };

  // The authoritative write returns the exact persisted health window. Do not
  // add observational reads before/after it: a slow optional snapshot must never
  // prevent the cooldown or the alternate provider dispatch. Without prior-row
  // evidence this is a persisted window, not a claimed entry/extension transition.
  const cooldown = async (memberId, reason, args, metric) => {
    const row = await engine.cooldown(memberId, reason);
    if (!(engine instanceof ProviderPoolEngine) || !row) return;
    const timestamp = value => value instanceof Date ? value.getTime() : Date.parse(value);
    const until = timestamp(row.cooldown_until), updated = timestamp(row.updated_at);
    if (!Number.isFinite(until) || !Number.isFinite(updated) || until <= updated || row.last_reason !== reason) return;
    deferProviderDiagnostic(args.traceLogger, () => providerObservation(args.traceLogger,'model',{ stage:'provider-pool-cooldown', requestId:metric.id, poolId:pool.connection.id, memberId, model:config.model,
      transition:'persisted', reason:reason === 'transport_unavailable' ? 'transport' : reason === 'http_429' ? 'rate_limited' : ['http_401','http_403'].includes(reason) ? 'authentication' : 'provider_failure',
      durationMs:until - updated, updatedAtMs:updated, cooldownUntilMs:until, boundary:'persisted-health-window' }), { optional:true });
  };
  const startMetrics = async args => {
    const started = now(), monotonicStarted = performance.now();
    let id;
    try { id = metrics ? await metrics.start({poolId:pool.connection.id,model:config.model,runId:args.runId || args.traceLogger?.runId}) : randomUUID(); }
    catch (error) { throw markModelInternalError(error, INTERNAL_DIAGNOSTIC_CODE); }
    deferProviderDiagnostic(args.traceLogger, () => providerObservation(args.traceLogger,'model',{ stage:'provider-pool-request', requestId:id, poolId:pool.connection.id,
      poolName:configuredProviderName(pool.connection.provider), model:config.model, provider:family, api:pool.connection.apiType }), { optional:true });
    return { id, started, monotonicStarted, attempts: 0, failovers:0, accountNames: new Map() };
  };
  const finishMetrics = async (metric, result, args) => {
    if (metric.finished) return;
    metric.finished = true;
    const outcome = args.signal?.aborted || result?.cancelled || result?.modelFailure?.origin === 'cancelled' ? 'cancelled' : result?.ok ? 'success' : 'failed';
    const errorKind = outcome === 'success' ? null : outcome === 'cancelled' ? 'cancelled' : result?.status ? 'provider_failure' : 'exception';
    const durationMs = Math.max(0, performance.now() - metric.monotonicStarted);
    let failure = null;
    try { await metrics?.finish(metric.id, { outcome, durationMs, errorKind }); } catch (error) { failure = error; }
    const accountId = result?.providerPool?.servingConnectionId;
    const outcomeRecord = {stage:'provider-pool-outcome',requestId:metric.id,poolId:pool.connection.id,model:config.model,
      ...(accountId ? { accountId, accountName:metric.accountNames.get(accountId) } : {}),
      ...providerCompletion(result, { error:result?.cause, signal:args.signal }),durationMs,attempts:metric.attempts,failovers:metric.failovers,...(metric.ttftMs !== undefined ? {ttftMs:metric.ttftMs} : {})};
    if (metrics) { try { await args.traceLogger?.model?.(outcomeRecord); } catch (error) { failure ||= error; } }
    else deferProviderDiagnostic(args.traceLogger, () => providerObservation(args.traceLogger,'model',outcomeRecord), { optional:true });
    if (failure) throw retainSecondary(failure, result);
  };
  const invoke = async (method, args = {}) => {
    const managed = args.recoveryContext && typeof args.recoveryContext === 'object';
    const run = async metric => {
      try {
        const result = await invokeInner(method, args, metric);
        if (managed && result?.ok === false) managedFailures.set(args.recoveryContext, result);
        return result;
      } catch (error) {
        // Snapshot retained metadata while still in the invocation's scope.
        const receipt = modelFailureResult(error, { signal: args.signal });
        if (managed && receipt.modelFailure?.origin === 'upstream') managedFailures.set(args.recoveryContext, receipt);
        throw error;
      }
    };
    const finalizers = args.recoveryContext?.finalizers;
    if (finalizers instanceof Map) {
      let finalize = finalizers.get(metricKey);
      if (!finalize) {
        const metric = await startMetrics(args);
        finalize = async result => finishMetrics(metric, result, args);
        finalize.metric = metric;
        finalizers.set(metricKey, finalize);
      }
      return run(finalize.metric);
    }
    // Direct callers retain one start/finish per public invocation.
    const metric = await startMetrics(args);
    let result, error;
    try { result = await run(metric); }
    catch (caught) { error = caught; result = modelFailureResult(caught, { signal: args.signal }); }
    await finishMetrics(metric, result, args);
    if (error) throw error;
    return result;
  };
  return { ...logical, provider: family, api: pool.connection.apiType, logicalConnectionId: pool.connection.id,
    complete: (args) => invoke('complete', args),
    continueWithToolResults: (args) => invoke('continueWithToolResults', args) };
}
