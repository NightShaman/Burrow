import { createNativeMinionTelemetry } from './native-minion-telemetry.mjs';
import { diagnosticText, collectDiagnosticSecrets, attachDiagnostics } from './native-minion-diagnostics.mjs';
import { projectCodexCheckpoint, codexHandoffContext, codexObservedEvidence } from './codex-native-checkpoint.mjs';
import { createCodexPoolRouting } from './codex-pool-routing.mjs';
import { openRemoteCodexProcess } from './codex-remote-process.mjs';
import { readSubagentRecord, updateSubagentStatus } from './subagent-store.mjs';
import { constants } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexMinionClient } from './codex-minion-client.mjs';
import { conversationAuthority } from './conversation-authority.mjs';
import { resolveProcessExecutionTarget } from './process-execution-router.mjs';
import { refreshOpenAiOAuth, openaiOAuthIdentity } from './openai-oauth-login.mjs';
import { isProviderPool } from './provider-pool-settings.mjs';
import { CODEX_SELECTION_ACTIONS } from './codex-model-selection.mjs';
import { normalizeExecutionPolicyInput } from './execution-policy.mjs';

const refreshes = new WeakMap();
const fail = (code) => { throw Object.assign(new Error(code), { runnerCode: code }); };

/** Explicit override is authoritative: a broken override never falls back to PATH. */
export async function discoverCodexExecutable(env = process.env) {
  const override = env.BURROW_CODEX_EXECUTABLE;
  if (override && !path.isAbsolute(override)) fail('codex_executable_override_must_be_absolute');
  const candidates = override ? [override] : String(env.PATH || '').split(path.delimiter)
    .filter((dir) => path.isAbsolute(dir)).map((dir) => path.join(dir, 'codex'));
  if (!override) {
    if (env.BURROW_RUNTIME_ROOT && path.isAbsolute(env.BURROW_RUNTIME_ROOT)) {
      candidates.push(path.join(env.BURROW_RUNTIME_ROOT, 'integrations', 'codex', 'node_modules', '.bin', 'codex'));
    }
    candidates.push(fileURLToPath(new URL('../runtime/integrations/codex/node_modules/.bin/codex', import.meta.url)));
    candidates.push(fileURLToPath(new URL('../node_modules/.bin/codex', import.meta.url)));
  }
  for (const candidate of candidates) {
    try {
      if (!(await fs.stat(candidate)).isFile()) continue;
      await fs.access(candidate, constants.X_OK);
      return candidate;
    } catch { /* discovery only; never disclose filesystem diagnostics */ }
  }
  fail('codex_executable_unavailable');
}

/** Server-only adapter. Admission, session initialization and terminal receipts remain parent-owned. */
export async function runCodexMinion({ id, task, target, dataRoot, childSessionId, owner = {},
  modelConfig, traceDir = null, parentExecutionContext = null,
  signal = parentExecutionContext?.abortSignal, executionPolicy = null, continuation = null, poolRecovery = null } = {}) {
  const cancellation = new AbortController();
  let nativeTelemetry;
  signal = signal ? AbortSignal.any([signal, cancellation.signal]) : cancellation.signal;
  let cancellationPoll;
  let nativeStarted = false;
  let recorded = false;
  let sequence = 0;
  let client;
  let launchAttempted = false;
  let authority;
  let dispatched = false;
  let writes = Promise.resolve();
  let persistenceFailed = false;
  let nativeSession;
  let conversationStore;
  let poolEngine = poolRecovery?.engine;
  let route;
  let connectionId;
  let toolObserved = false;
  let outputObserved = false;
  let preparedHistory = continuation?.preparedHistory || [];
  let retry;
  let recoveryContinuation;
  let checkpointFailure;
  let providerReason;
  let retryNotBefore;
  let refreshFailed = false;
  let actualModel = null;
  const saveNative = async (patch) => {
    nativeSession = { ...nativeSession, ...patch };
    await conversationStore.updateMetadata({ agentId: owner.agentId, sessionId: childSessionId,
      update: old => ({ ...old, codexSession: nativeSession }) });
  };
  const secrets = new Set();
  collectDiagnosticSecrets(secrets, process.env);
  const redact = (value) => {
    let text = String(value || '');
    for (const secret of [...secrets].sort((a, b) => b.length - a.length)) if (secret) text = text.split(secret).join('[redacted]');
    return text;
  };
  const base = { evidence: [], artifacts: [], changedFiles: [], memoryWrites: [],
    verificationTarget: target?.root || null, verification: { status: 'not_run',
      check: 'Native Codex work independently verified by Burrow', observed: 'Native tool results are not promoted Burrow evidence.', actionRequired: false } };
  const append = (content, activity = false) => authority.append({ sessionId: childSessionId,
    runId: id, traceDir, type: activity ? 'event' : 'message', role: activity ? null : 'assistant',
    content: redact(content), visibility: activity ? 'activity' : 'chat', entersPrompt: !activity,
    metadata: { kind: activity ? 'codex-minion-activity' : 'codex-minion-response', subagentExecution: true } });
  let result;
  try {
    // Check host routing before touching the target path, credentials or executable.
    const executionHost = resolveProcessExecutionTarget(parentExecutionContext || {});
    const remote = executionHost.kind === 'remote';
    nativeTelemetry = createNativeMinionTelemetry({ harness: 'codex', runId: id, telemetry: parentExecutionContext?.telemetry,
      executionTarget: remote ? 'remote' : 'local', requestedModel: modelConfig?.model, redact });
    const savedHost = continuation?.executionHost || { kind: 'local' };
    if (continuation && (savedHost.kind !== executionHost.kind || savedHost.providerId !== executionHost.providerId || savedHost.targetId !== executionHost.targetId)) fail('codex_session_host_changed');
    const remoteController = parentExecutionContext?.processExecutionController;
    if (remote && typeof remoteController?.codexRpc !== 'function') fail('codex_remote_app_server_unavailable');
    const boundaries = parentExecutionContext?.executionBoundaries;
    if (boundaries && (!Array.isArray(boundaries.hardBlocks) || boundaries.hardBlocks.some(rule => rule.enabled !== false))) fail('codex_execution_boundaries_unsupported');
    if (!id || !task?.trim() || !dataRoot || !childSessionId) fail('codex_runner_input_required');
    if (target?.kind !== 'filesystem' || !path.isAbsolute(target.root || '')) fail('codex_target_invalid');
    if (!remote && !(await fs.stat(target.root)).isDirectory()) fail('codex_target_invalid');
    if (!owner.agentId || (parentExecutionContext?.agentId && owner.agentId !== parentExecutionContext.agentId)) fail('codex_owner_invalid');
    const models = parentExecutionContext?.stores?.models;
    if (!models?.get || !models?.auth || !models?.resolveAuth) fail('codex_model_settings_store_required');
    const logicalConnectionId = modelConfig?.connectionId;
    connectionId = logicalConnectionId;
    if (!connectionId || !modelConfig?.model) fail('codex_model_selection_required');
    const connection = await models.get(connectionId);
    if (!connection) fail('codex_connection_not_found');
    if (isProviderPool(connection)) {
      poolEngine ||= await createCodexPoolRouting(models, logicalConnectionId, modelConfig.model, parentExecutionContext);
      route = await poolEngine.select({ threadKey: childSessionId, model: modelConfig.model,
        exclude: poolRecovery?.exclude || [], preferredMemberId: continuation?.resolvedConnectionId,
        requiredMemberId: continuation && !continuation.portableHistory ? continuation.resolvedConnectionId : null });
      connectionId = route.memberId;
    } else if (!['openai-responses', 'openai-chat-completions'].includes(connection.apiType)) fail('codex_openai_oauth_required');
    if (!isProviderPool(connection) && !(connection.models || []).some((model) => model.id === modelConfig.model && model.selected !== false)) fail('codex_model_not_enabled');
    conversationStore = parentExecutionContext?.conversationStore || parentExecutionContext?.stores?.conversations;
    authority = conversationAuthority({ store: conversationStore, agentId: owner.agentId });
    if (!conversationStore.updateMetadata) fail('codex_session_metadata_required');
    if (continuation && (!continuation.threadId || continuation.state === 'running')) fail('codex_session_unavailable');
    const tokens = async (force = false) => {
      signal?.throwIfAborted();
      const prior = await models.auth(connectionId);
      if (prior?.type !== 'oauth' || String(prior.provider || '').toLowerCase() !== 'openai') fail('codex_openai_oauth_required');
      for (const value of [prior.accessToken, prior.refreshToken, prior.idToken]) if (value) secrets.add(value);
      if (force) {
        if (!models.persistAuth) fail('codex_oauth_refresh_unavailable');
        let pending = refreshes.get(models);
        if (!pending) { pending = new Map(); refreshes.set(models, pending); }
        if (!pending.has(connectionId)) {
          const refresh = (async () => {
            const current = await models.auth(connectionId);
            if (current?.type !== 'oauth' || String(current.provider || '').toLowerCase() !== 'openai') fail('codex_openai_oauth_required');
            const fresh = await refreshOpenAiOAuth(current, { signal: AbortSignal.timeout(8_000) });
            await models.persistAuth(connectionId, fresh, undefined, current.refreshToken, current);
          })();
          pending.set(connectionId, refresh);
          refresh.finally(() => pending.delete(connectionId)).catch(() => {});
        }
        await pending.get(connectionId);
      }
      // Normal expiry refresh remains owned by the store's advisory-lock lifecycle.
      const resolved = await models.resolveAuth(connectionId, { signal });
      if (resolved.type !== 'oauth' || !resolved.token) fail('codex_openai_oauth_required');
      secrets.add(resolved.token);
      const identity = openaiOAuthIdentity(resolved.token);
      const saved = await models.auth(connectionId);
      for (const value of [saved?.accessToken, saved?.refreshToken, saved?.idToken]) if (value) secrets.add(value);
      const accountId = identity.accountId || (saved?.accessToken === resolved.token ? saved.accountId : null);
      if (!accountId) fail('codex_oauth_account_required');
      return { accessToken: resolved.token, chatgptAccountId: accountId,
        ...(identity.planType ? { chatgptPlanType: identity.planType } : {}) };
    };
    recorded = !continuation && Boolean(await readSubagentRecord({ dataRoot, id }));
    if (recorded) {
      cancellationPoll = setInterval(() => {
        void readSubagentRecord({ dataRoot, id }).then(record => {
          if (record?.status === 'cancelled') cancellation.abort();
        }).catch(() => cancellation.abort());
      }, 200);
      cancellationPoll.unref();
    }
    const executable = remote ? null : await discoverCodexExecutable();
    const login = await tokens();
    const handoff = continuation && (poolRecovery?.replay || continuation.accountId !== login.chatgptAccountId
      || (continuation.resolvedConnectionId && continuation.resolvedConnectionId !== connectionId));
    if (handoff && (!poolEngine || !['ready', 'failed'].includes(continuation.state) || !continuation.portableHistory
      || !Array.isArray(continuation.preparedHistory) || !continuation.preparedHistory.length)) {
      fail(poolEngine ? 'codex_pool_replay_unavailable' : 'codex_session_account_changed');
    }
    const policy = normalizeExecutionPolicyInput(executionPolicy);
    if (policy.blockers.length) fail('codex_execution_policy_blocked');
    signal?.throwIfAborted();
    launchAttempted = true;
    const remoteProcess = remote ? await openRemoteCodexProcess(remoteController, executionHost.targetId, target.root) : null;
    client = new CodexMinionClient({ executable, cwd: target.root, redact,
      ...(remoteProcess ? { spawnProcess: () => { queueMicrotask(() => remoteProcess.start()); return remoteProcess; } } : {}),
      refreshAuthTokens: async () => {
        try {
          const fresh = await tokens(true);
          if (fresh.chatgptAccountId !== login.chatgptAccountId) fail('codex_session_account_changed');
          return fresh;
        }
        catch (error) { refreshFailed = true; throw error; }
      },
      onActivity: ({ method, params }) => {
        if (['item/started', 'item/completed'].includes(method)
          && !['agentMessage', 'userMessage', 'reasoning'].includes(params?.item?.type)) toolObserved = true;
        if (method === 'item/agentMessage/delta' || method === 'item/reasoning/textDelta'
          || (['item/started', 'item/completed'].includes(method) && params?.item?.type === 'agentMessage')) outputObserved = true;
        if (method === 'model/rerouted' && typeof params?.toModel === 'string') actualModel = redact(params.toModel);
        // Public activity is labels only; private checkpoint metadata is projected separately.
        const label = { 'turn/started': 'Codex turn started.', 'item/started': 'Codex item started.',
          'item/completed': 'Codex item completed.', 'turn/completed': 'Codex turn completed.' }[method];
        if (label) writes = writes.then(async () => {
          await append(label, true);
          if (recorded && !signal.aborted) await updateSubagentStatus({ dataRoot, id, status: 'running', phase: 'codex-native',
            activity: { kind: 'run', status: 'running', phase: 'codex-native', label, sequence: ++sequence, lastActualActivityAt: new Date().toISOString() } });
        }).catch(() => { persistenceFailed = true; });
      },
    });
    // Cancellation covers initialization/login/thread RPCs as well as the turn.
    const abort = () => {
      // Interrupt an active native turn before process teardown; initialization
      // has no turn to interrupt and is closed immediately.
      void (client.active ? client.interrupt().finally(() => client.close()) : client.close()).catch(() => {});
    };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      signal?.throwIfAborted();
      await append('Codex app-server starting.', true);
      nativeStarted = true;
      await client.initialize();
      await client.login(login);
      const threadParams = { cwd: target.root, model: modelConfig.model,
        approvalPolicy: 'never', sandbox: policy.mayMutate ? 'danger-full-access' : 'read-only' };
      const threadResult = continuation && !handoff
        ? await client.resumeThread(continuation.threadId, threadParams)
        : await client.startThread({ ...threadParams, ephemeral: false });
      const { thread } = threadResult;
      actualModel = threadResult.model ? redact(threadResult.model) : null;
      if (!thread?.id || (continuation && !handoff && thread.id !== continuation.threadId)) fail('codex_thread_invalid');
      // Repair a completed turn's missing export before accepting new work. Never
      // resubmit that turn: its workspace effects may already have happened.
      if (continuation?.pendingCheckpoint) {
        const pending = continuation.pendingCheckpoint;
        try {
          const savedTurn = await client.readTurn(thread.id, pending.turnId);
          const projection = projectCodexCheckpoint(savedTurn, { threadId: thread.id,
            task: pending.task, observed: pending.observed, redact });
          if (!projection.portable) fail('codex_checkpoint_repair_required');
          preparedHistory = [...preparedHistory.slice(0, pending.historyLength), projection.checkpoint];
          if (JSON.stringify(preparedHistory).length > 1_000_000) fail('codex_checkpoint_repair_required');
          continuation = { ...continuation, preparedHistory, portableHistory: pending.priorPortable,
            pendingCheckpoint: null, checkpointFailure: null };
          nativeSession = { ...continuation };
          await saveNative({ preparedHistory, portableHistory: pending.priorPortable,
            pendingCheckpoint: null, checkpointFailure: null });
        } catch { fail('codex_checkpoint_repair_required'); }
      }
      nativeSession = { version: 2, threadId: thread.id, target, executionHost, resolvedConnectionId: connectionId, modelConfig: { connectionId: logicalConnectionId, model: modelConfig.model,
        ...(modelConfig.extra ? { extra: modelConfig.extra } : {}) }, executionPolicy: policy, accountId: login.chatgptAccountId };
      // Persist resume identity before dispatch: never silently create a new thread
      // if the native turn later fails, is cancelled, or Burrow loses its process.
      await saveNative({ state: 'running', runId: id, portableHistory: false, preparedHistory });
      signal?.throwIfAborted();
      dispatched = true;
      nativeTelemetry?.start({ model: actualModel, fresh: !continuation || Boolean(handoff) });
      const turn = await client.startTurn({ threadId: thread.id,
        ...(modelConfig.extra?.reasoning?.effort ? { effort: modelConfig.extra.reasoning.effort } : {}),
        input: [{ type: 'text', text: `${handoff || poolRecovery?.replay ? codexHandoffContext(preparedHistory) : ''}Working directory: ${target.root}\nDo not commit changes unless explicitly permitted: ${policy.mayCommit}.\nReturn readable Markdown findings and disclose verification gaps.\n\n${poolRecovery?.reconciled ? 'Continue the unfinished work in the last checkpoint. Completed actions must not be repeated.' : task}` }] }, { signal, onTurnEvent: nativeTelemetry?.observe });
      const final = turn.items.filter((item) => item.type === 'agentMessage' && item.phase === 'final_answer');
      const summary = redact((final.length ? final.map((item) => item.text).join('\n') : turn.text).trim());
      if (!summary) fail('codex_final_response_missing');
      await writes;
      if (persistenceFailed) fail('codex_transcript_write_failed');
      await append(summary);
      let portableHistory = !continuation || continuation.portableHistory === true;
      let checkpoint;
      {
        await saveNative({ completedActionEvidence: codexObservedEvidence(turn.observed,
          { threadId: thread.id, task, redact }) });
        try {
          const nativeTurn = await client.readTurn(thread.id, turn.turnId);
          const projection = projectCodexCheckpoint(nativeTurn, { threadId: thread.id, task,
            observed: turn.observed, redact });
          portableHistory &&= projection.portable;
          checkpoint = projection.checkpoint;
          checkpointFailure = projection.reason;
        } catch { portableHistory = false; checkpointFailure = 'native_history_unavailable'; }
      }
      const pendingCheckpoint = checkpointFailure === 'native_history_unavailable' ? { turnId: turn.turnId,
        task: redact(task), observed: JSON.parse(redact(JSON.stringify(turn.observed || []))),
        historyLength: preparedHistory.length, priorPortable: !continuation || continuation.portableHistory === true } : null;
      preparedHistory = [...preparedHistory, ...(checkpoint ? [checkpoint] : [{ role: 'user', content: redact(task) },
        ...turn.items.filter(item => item.type === 'agentMessage').map(item => ({ role: 'assistant', content: redact(item.text) }))])];
      const boundedHistory = JSON.stringify(preparedHistory).length <= 1_000_000;
      if (poolEngine && route.substitute && (handoff || poolRecovery?.replay || route.rebalanceReason)) {
        const promoted = await poolEngine.promote({ threadKey: childSessionId, memberId: connectionId, previousOwnerId: route.ownerId });
        if (promoted) route = { ...route, ownerId: connectionId, substitute: false };
      }
      await saveNative({ state: 'ready', actualModel, portableHistory: portableHistory && boundedHistory,
        pendingCheckpoint, preparedHistory: boundedHistory ? preparedHistory : [], checkpointFailure: checkpointFailure || null });
      result = { ...base, ok: true, summary, blockers: [],
        warnings: ['codex_native_tool_evidence_not_promoted', ...(portableHistory && boundedHistory ? [] : ['codex_checkpoint_not_portable'])], sideEffectsApplied: null };
    } finally { signal?.removeEventListener('abort', abort); }
  } catch (error) {
    if (nativeSession && error.nativeTurn) {
      try { await saveNative({ completedActionEvidence: codexObservedEvidence(error.nativeTurn.observed,
        { threadId: nativeSession.threadId, task, redact }) }); }
      catch { persistenceFailed = true; }
    }
    retryNotBefore = error?.retryNotBefore;
    if (refreshFailed && !error?.status) error = Object.assign(new Error('codex_oauth_refresh_failed'), { status: 401, providerReason: 'authentication_refresh_failed' });
    providerReason = error?.providerReason || poolRecovery?.providerReason;
    if (poolEngine && route && !signal.aborted && ([401, 403, 429].includes(error?.status) || (Number.isInteger(error?.status) && error.status >= 500 && error.status <= 599))) {
      try {
        const knownReset = route.diagnostics?.find(row => row.id === connectionId)?.blockedUntil;
        const health = await poolEngine.cooldown(connectionId, `http_${error.status}`,
          Math.max(60_000, (knownReset || 0) - Date.now(), (retryNotBefore || 0) - Date.now()));
        const until = new Date(health?.cooldown_until).getTime();
        if (Number.isFinite(until)) retryNotBefore = Math.max(retryNotBefore || 0, until);
        // Only a terminal authoritative turn can reconcile effects after exhaustion.
        // A transport loss, missing result, or still-running action remains blocked.
        if (error.nativeTurn?.turnId && client && !client.closed && !persistenceFailed) {
          try {
            const turn = await client.readTurn(nativeSession.threadId, error.nativeTurn.turnId);
            const projection = projectCodexCheckpoint(turn, { threadId: nativeSession.threadId,
              task, observed: error.nativeTurn.observed, redact });
            const history = [...preparedHistory, projection.checkpoint];
            if (projection.portable && (toolObserved || !outputObserved) && (!continuation || continuation.portableHistory)
                && JSON.stringify(history).length <= 1_000_000) {
              preparedHistory = history;
              await saveNative({ state: 'failed', portableHistory: true, preparedHistory, reconciled: true });
              recoveryContinuation = { ...nativeSession };
              if (!poolRecovery) retry = { engine: poolEngine, exclude: [connectionId], replay: true, reconciled: true, providerReason };
            } else checkpointFailure = projection.reason || 'incomplete_prior_history';
          } catch { checkpointFailure = 'native_history_unavailable'; }
        }
        if (!poolRecovery && !error.nativeTurn?.turnId && !persistenceFailed && !toolObserved && !outputObserved && (!continuation || (continuation.state === 'ready' && continuation.portableHistory))) {
          retry = { engine: poolEngine, exclude: [...(poolRecovery?.exclude || []), connectionId], replay: true, providerReason };
        }
      } catch { /* Preserve the original sanitized provider failure. */ }
    }
    const replayBlocked = poolEngine && ((toolObserved && Boolean(providerReason))
      || error?.message === 'provider_pool_continuation_owner_unavailable');
    const code = signal?.aborted ? 'codex_cancelled' : replayBlocked ? 'codex_pool_replay_unavailable' : error?.runnerCode || (error?.code === 'TURN_TIMEOUT' ? 'codex_turn_timeout' : null) || (['provider_pool_no_eligible_members', 'provider_pool_disabled'].includes(error?.message) ? error.message : 'codex_native_run_failed');
    result = { ...base, ok: false, summary: signal?.aborted ? 'Codex minion cancelled.' : (code === 'codex_turn_timeout' ? 'Codex turn exceeded its explicitly configured time limit.' : null) || CODEX_SELECTION_ACTIONS[code] || (providerReason ? `Codex provider rejected the request (${providerReason}). Check account access or quota and retry.` : 'Codex minion unavailable or failed.'),
      blockers: [code], warnings: [], sideEffectsApplied: dispatched ? null : false };
    if (launchAttempted && !client) attachDiagnostics(result, { stage: 'open', processError: diagnosticText(error?.message, redact), ...(error?.code ? { code: diagnosticText(String(error.code), redact) } : {}) });
  } finally {
    nativeTelemetry?.finish(result, { cancelled: signal.aborted, timedOut: result?.blockers?.includes('codex_turn_timeout') });
    clearInterval(cancellationPoll);
    if (nativeSession && !result?.ok) {
      try { await saveNative({ state: signal.aborted ? 'interrupted' : 'failed', ...(checkpointFailure ? { checkpointFailure } : {}) }); }
      catch { /* Original failure stays sanitized; stale running state fails closed. */ }
    }
    await writes;
    try { await client?.close(); } catch {
      if (nativeSession) {
        try { await saveNative({ state: 'running', cleanupUnconfirmed: true }); } catch { /* Fail closed where possible. */ }
      }
      result = { ...result, ...base, ok: false, summary: 'Codex process cleanup could not be confirmed.',
        blockers: ['codex_cleanup_failed'], warnings: [], sideEffectsApplied: dispatched ? null : false };
    }
  }
  if (client && !result.ok) attachDiagnostics(result, client.diagnostics.snapshot());
  if (poolRecovery?.originalResult && !route) {
    result = { ...poolRecovery.originalResult, warnings: [...(poolRecovery.originalResult.warnings || []), 'codex_pool_alternate_unavailable'] };
  }
  if (retry && result.blockers?.[0] !== 'codex_cleanup_failed') {
    return runCodexMinion({ id, task, target, dataRoot, childSessionId, owner, modelConfig, traceDir,
      parentExecutionContext, signal, executionPolicy, continuation: recoveryContinuation || continuation, poolRecovery: { ...retry, originalResult: { ...result,
        model: { requested: modelConfig.model, actual: actualModel, connectionId },
        providerPool: { logicalConnectionId: modelConfig.connectionId, memberId: connectionId, ownerId: route.ownerId, substitute: route.substitute } } } });
  }
  return { ...result, ...(route ? { providerPool: { logicalConnectionId: modelConfig.connectionId,
    memberId: connectionId, ownerId: route.ownerId, substitute: route.substitute } } : {}),
    model: poolRecovery?.originalResult && !route ? poolRecovery.originalResult.model
      : { requested: modelConfig?.model || null, actual: actualModel, connectionId: connectionId || null },
    ...(providerReason ? { providerReason } : {}), ...(retryNotBefore ? { retryNotBefore } : {}),
    spawned: nativeStarted || Boolean(poolRecovery?.originalResult), cancelled: signal.aborted };
}
