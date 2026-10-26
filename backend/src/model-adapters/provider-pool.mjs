import { poolAttemptUsage } from '../postgres-provider-pool-metrics.mjs';
import { portablePoolReplay } from './pool-replay.mjs';
import { ProviderPoolEngine, poolThreadKey, AFFINITY_CACHE_TTL_MS } from '../provider-pool-engine.mjs';

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
  const getAdapter = async (memberId, threadKey, fresh = false) => {
    const key = JSON.stringify([threadKey, memberId]);
    const cached = adapters.get(key);
    const resolved = await pool.resolveMember(memberId);
    const memberConfig = resolved?.model && typeof resolved.model === 'object' ? resolved.model : resolved;
    if (!memberConfig || memberConfig.providerPool || /-lb$/.test(memberConfig.api || memberConfig.apiType || '')) throw new Error('provider_pool_invalid_member_config');
    if (!fresh && cached && cached.authToken === memberConfig.apiKey && now() - cached.usedAt < AFFINITY_CACHE_TTL_MS) { cached.usedAt = now(); return cached.adapter; }
    const adapter = createMemberAdapter({ ...options, providerPool: null, config: { ...memberConfig, model: config.model, temperature: config.temperature, maxTokens: config.maxTokens, extra: config.extra, reasoningEffort: config.reasoningEffort, codexSessionId: threadKey, codexThreadId: threadKey, providerPool: null } });
    // Native turn-state is isolated by both thread AND account, never copied.
    for (const [oldKey, value] of adapters) if (now() - value.usedAt >= AFFINITY_CACHE_TTL_MS) adapters.delete(oldKey);
    if (adapters.size >= 1000) adapters.delete(adapters.keys().next().value);
    adapters.set(key, { adapter, authToken: memberConfig.apiKey, usedAt: now() });
    return adapter;
  };
  const metrics = family === 'openai' ? pool.store?.providerPoolMetrics : null;
  const invokeInner = async (method, args = {}) => {
    const previousRoute = args.previousModel?.providerPool;
    let continuation = method !== 'complete' || Boolean(args.toolContinuation);
    // Complete() can also be given opaque signed Anthropic history. Without
    // explicit route provenance it is not portable between OAuth accounts.
    const history = [...(args.messages || []), ...(args.preparedMessages || []), ...(args.baseMessages || [])];
    const signedHistory = history.some((message) => Array.isArray(message?.content)
      && message.content.some((part) => part?.type === 'thinking' || part?.type === 'redacted_thinking'));
    const nativeHistory = signedHistory || history.some(message => ['function_call', 'function_call_output'].includes(message?.type));
    if (nativeHistory && !previousRoute?.servingConnectionId) throw new Error('provider_pool_signed_history_owner_missing');
    if (nativeHistory) continuation = true;
    // A successful initial response proves only its submitted request, not
    // historical protocol rounds supplied by the caller or a resumed turn.
    const initialRequest = Array.isArray(args.messages) ? args.messages :
      args.prompt != null ? [{ role: 'user', content: args.prompt }] : [];
    const protocolHistory = initialRequest.some(message => message?.role === 'tool' ||
      ['function_call', 'function_call_output'].includes(message?.type) ||
      Array.isArray(message?.tool_calls) && message.tool_calls.length ||
      Array.isArray(message?.content) && message.content.some(part =>
        ['tool_use', 'tool_result', 'thinking', 'redacted_thinking'].includes(part?.type)));
    const freshRequest = method === 'complete' && !continuation && !previousRoute && !protocolHistory;
    // A continuation without provenance cannot safely infer its native owner.
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
    const threadKey = previousRoute?.threadKey || poolThreadKey(args);
    const excluded = [];
    let originalFailure;
    let originalRoute;
    for (let attempt = 0; attempt < 2; attempt++) {
      args.signal?.throwIfAborted();
      let selection;
      try { selection = await engine.select({ threadKey, model: config.model, exclude: excluded,
        requiredMemberId: continuation && !(attempt && replay && !replay.error) ? previousRoute.servingConnectionId : null }); }
      catch (error) {
        if (!originalFailure) throw error;
        if (originalFailure instanceof Error) throw originalFailure;
        return { ...originalFailure, providerPool: originalRoute, nativeTranscriptComplete: false };
      }
      let adapter;
      try { adapter = await getAdapter(selection.memberId, threadKey, attempt > 0); }
      catch (error) {
        if (!originalFailure) throw error;
        if (originalFailure instanceof Error) throw originalFailure;
        return { ...originalFailure, providerPool: originalRoute, nativeTranscriptComplete: false };
      }
      let visible = false;
      let callbackFailed = false;
      let callbackInvoked = false;
      const callArgs = { ...(attempt && replay && !replay.error ? replay : args) };
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
      await args.traceLogger?.model?.({ stage: 'provider-pool-selection', ...route, model: config.model });
      let result;
      const attemptStarted = now();
      const capture = async (result, error = null) => {
        if (!args.poolMetricId) return;
        const measurement = { attempt: attempt + 1, memberId: selection.memberId,
          providerRequestId: result?.requestId, durationMs: Math.max(0, now()-attemptStarted),
          outcome: args.signal?.aborted || error?.name === 'AbortError' ? 'cancelled' : result?.ok ? 'success' : 'failed',
          status: result?.status, errorKind: error ? (args.signal?.aborted ? 'cancelled' : 'exception') : result?.ok ? null : 'provider_failure',
          ...poolAttemptUsage(result?.usage) };
        await metrics.attempt(args.poolMetricId, measurement);
        await args.traceLogger?.model?.({stage:'provider-pool-attempt',requestId:args.poolMetricId,
          poolId:pool.connection.id,model:config.model,...measurement});
      };
      try { result = await adapter[method](callArgs); }
      catch (error) {
        await capture(null, error);
        // Unknown exceptions can represent callback, serialization or policy
        // failures. Only transport TypeErrors are retryable, never cancellation.
        if (callbackFailed || callbackInvoked || visible || (continuation && (!replay || replay.error)) || args.signal?.aborted || error?.name !== 'TypeError' || attempt > 0) throw error;
        originalFailure = error; originalRoute = route;
        await engine.cooldown(selection.memberId, 'transport_unavailable');
        excluded.push(selection.memberId);
        continue;
      }
      await capture(result);
      const retryable = !result.ok && ([401, 403, 429].includes(Number(result.status)) || (Number(result.status) >= 500 && Number(result.status) <= 599));
      if (retryable) await engine.cooldown(selection.memberId, `http_${result.status}`);
      if (retryable && continuation && replay?.error && !callbackInvoked && !visible && !args.signal?.aborted && attempt === 0 && !result.choice?.text && !result.choice?.toolCalls?.length) throw replay.error;
      if (retryable && !callbackInvoked && !visible && (!continuation || (replay && !replay.error)) && !args.signal?.aborted && attempt === 0
        && !result.choice?.text && !result.choice?.toolCalls?.length) {
        originalFailure = result; originalRoute = route;
        excluded.push(selection.memberId);
        continue;
      }
      if (result.ok && (selection.rebalanceReason || (attempt && replay && !replay.error)) && typeof engine.promote === 'function') {
        const promoted = await engine.promote({ threadKey, memberId: selection.memberId, previousOwnerId: selection.rebalanceReason ? selection.ownerId : originalRoute?.ownerConnectionId });
        if (promoted) { route.ownerConnectionId = selection.memberId; route.substitute = false; }
      }
      // Request-scoped proof: normal pre-request compaction is irrelevant;
      // mid-loop changes are rejected by portablePoolReplay equality.
      return { ...result, providerPool: route, nativeTranscriptComplete: result.ok === true &&
        (continuation ? Boolean(replay && !replay.error) : freshRequest) };
    }
    throw new Error('provider_pool_retry_exhausted');
  };
  // One measurement per public pool invocation, never on member/wrapper calls.
  const invoke = async (method, args = {}) => {
    if (!metrics) return invokeInner(method, args);
    const started = now();
    const id = await metrics.start({poolId:pool.connection.id,model:config.model,runId:args.runId || args.traceLogger?.runId});
    let outcome = 'failed';
    let errorKind = null;
    try {
      const result = await invokeInner(method, {...args,poolMetricId:id});
      outcome = result.ok ? 'success' : args.signal?.aborted ? 'cancelled' : 'failed';
      errorKind = result.ok ? null : 'provider_failure';
      return result;
    } catch (error) {
      outcome = args.signal?.aborted || error?.name === 'AbortError' ? 'cancelled' : 'failed';
      errorKind = outcome === 'cancelled' ? 'cancelled' : 'exception';
      throw error;
    } finally {
      const durationMs = Math.max(0,now()-started);
      await metrics.finish(id,{outcome,durationMs,errorKind});
      await args.traceLogger?.model?.({stage:'provider-pool-outcome',requestId:id,poolId:pool.connection.id,model:config.model,outcome,durationMs});
    }
  };
  return { ...logical, provider: family, api: pool.connection.apiType, logicalConnectionId: pool.connection.id,
    complete: (args) => invoke('complete', args),
    continueWithToolResults: (args) => invoke('continueWithToolResults', args) };
}
