import { createHash } from 'node:crypto';
import path from 'node:path';
import { MODEL_REASONING_EFFORT_VALUES, resolveModelConfig } from './config.mjs';
import { createExecutionContext, resolveExecutionTarget } from './execution-context.mjs';
import { nativeToolSchemas } from './action-proposal.mjs';
import { createExecutionPolicy } from './execution-policy.mjs';
import { validateCodexModelSelection } from './codex-model-selection.mjs';
import { validateClaudeModelSelection } from './claude-model-selection.mjs';
import { validateGeminiModelSelection } from './gemini-model-selection.mjs';
import { discoverCodexExecutable } from './codex-minion-runner.mjs';
import { discoverClaudeExecutable } from './claude-minion-runner.mjs';
import { discoverGeminiExecutable } from './gemini-minion-runner.mjs';
import { canSpawnMinion, readMinionSettings } from './minion-depth.mjs';
import { assertProviderPoolMembers, isProviderPool } from './provider-pool-settings.mjs';
import { remoteExecutionTarget } from './process-execution-router.mjs';
import { resolveRemoteTarget } from './subagent-spawn-execution.mjs';
import { createSubagentRecord, updateSubagentStatus } from './subagent-store.mjs';
import { finishSubagentChildSession, startSubagentChildSession, subagentChildSessionId } from './subagent-session.mjs';
import { runSpawnSubagentChild } from './subagent-worker-runner.mjs';

const HARNESSES = ['burrow', 'codex', 'claude', 'gemini'];
const VALIDATORS = { codex: validateCodexModelSelection, claude: validateClaudeModelSelection, gemini: validateGeminiModelSelection };
const DISCOVER = { codex: discoverCodexExecutable, claude: discoverClaudeExecutable, gemini: discoverGeminiExecutable };

function remoteHostId(id) {
  if (typeof id !== 'string' || id.length > 256 || !id.trim() || id !== id.trim()) return null;
  const colon = id.indexOf(':');
  if (colon < 1 || colon === id.length - 1) return null;
  return { providerId: id.slice(0, colon), targetId: id.slice(colon + 1) };
}

function supportedEfforts(harness, model) {
  // The native Claude/Gemini adapters have no explicit effort transport. Never
  // advertise a setting they would silently drop. Null leaves their defaults.
  if (harness === 'claude' || harness === 'gemini') return [];
  const declared = (Array.isArray(model.reasoningEfforts) ? model.reasoningEfforts : [])
    .filter(value => MODEL_REASONING_EFFORT_VALUES.includes(value));
  // Burrow's direct adapter has an explicit off control. Codex's app-server
  // forwards an explicit effort verbatim; off is only valid if advertised.
  return [...new Set(harness === 'burrow' ? ['off', ...declared] : declared)];
}

async function eligiblePair(models, harness, connection, model) {
  if (connection.enabled === false || model.selected === false || !model.id) return false;
  if (harness === 'burrow') {
    // Configuration metadata only. Dispatch still resolves live credentials
    // (and performs OAuth refresh) through resolveModelConfig.
    if (!isProviderPool(connection)) return connection.authConfigured !== false && Boolean(connection.auth?.type);
    if (!connection.pool?.enabled) return false;
    try {
      const members = await Promise.all(connection.pool.memberConnectionIds.map(id => models.get(id)));
      assertProviderPoolMembers(connection, members.filter(Boolean));
      return members.some(member => member?.enabled !== false && member?.auth?.configured !== false
        && member.models?.some(item => item.id === model.id && item.selected !== false));
    } catch { return false; }
  }
  try {
    await VALIDATORS[harness](models, { connectionId: connection.id, model: model.id });
    return true;
  } catch { return false; }
}

export function createModMinionBridgeRuntime({ stores, runtimeRoot, executionProviders = null, telemetry = null } = {}) {
  if (!stores?.models || !stores?.conversations || !runtimeRoot) throw new Error('mod_minion_runtime_dependencies_required');

  async function hostRows(executionHostIds) {
    const ids = new Set(['local', ...executionHostIds]);
    // Enumeration is optional. Describing explicitly known targets works with
    // providers that expose no listHosts IPC (including Node Goblin).
    if (typeof executionProviders?.listHosts === 'function') {
      try {
        for (const host of await executionProviders.listHosts()) {
          if (host?.providerId && host?.id) ids.add(`${host.providerId}:${host.id}`);
        }
      } catch { /* Known hosts are still individually described below. */ }
    }
    const localCli = Object.fromEntries(await Promise.all(Object.entries(DISCOVER).map(async ([harness, discover]) => {
      try { await discover(); return [harness, true]; } catch { return [harness, false]; }
    })));
    const hosts = [];
    for (const id of ids) {
      const remote = id === 'local' ? null : remoteHostId(id);
      const controller = remote && executionProviders?.get?.(remote.providerId);
      let description = null;
      if (remote && typeof controller?.describeHost === 'function') {
        try { description = await controller.describeHost(remote.targetId); } catch { /* unresponsive provider */ }
      }
      const available = id === 'local' || Boolean(description && description.available !== false && typeof controller?.executeProcess === 'function');
      const harnesses = HARNESSES.map(harness => {
        const blockers = [];
        if (!available) blockers.push('execution_host_unavailable');
        if (available && harness !== 'burrow') {
          if (id === 'local' && !localCli[harness]) blockers.push(`${harness}_executable_unavailable`);
          if (remote && typeof controller.codexRpc !== 'function') blockers.push(`${harness}_remote_transport_unavailable`);
          // A provider can disclose a stricter per-harness readiness projection.
          const advertised = description?.harnesses?.[harness];
          if (advertised === false || advertised?.available === false) blockers.push(`${harness}_execution_host_unavailable`);
        }
        return { id: harness, available: blockers.length === 0, blockers };
      });
      hosts.push({ id, name: description?.name || (id === 'local' ? 'Local Core host' : id),
        available, blockers: available ? [] : ['execution_host_unavailable'], harnesses });
    }
    return hosts;
  }

  async function catalog({ executionHostIds = [] } = {}) {
    const settings = await readMinionSettings(stores.metadata, null);
    const rows = await stores.models.list();
    const hosts = await hostRows(executionHostIds);
    const harnesses = [];
    for (const id of HARNESSES) {
      const globallyAllowed = settings.maxDepth > 0;
      const enabled = globallyAllowed && (id === 'burrow' || settings[`${id}Enabled`] === true);
      const blockers = [];
      const connections = [];
      if (!globallyAllowed) blockers.push('minions_disabled_by_max_depth');
      else if (!enabled) blockers.push(`${id}_minions_disabled`);
      if (enabled) for (const connection of rows) {
        const models = [];
        for (const model of connection.models || []) {
          if (await eligiblePair(stores.models, id, connection, model)) {
            models.push({ id: model.id, name: model.name || model.id, reasoningEfforts: supportedEfforts(id, model) });
          }
        }
        if (models.length) connections.push({ id: connection.id, name: connection.name || connection.provider || connection.id, models });
      }
      if (enabled && !connections.length) blockers.push('no_eligible_enabled_model_connection');
      harnesses.push({ id, name: id === 'burrow' ? 'Burrow' : id[0].toUpperCase() + id.slice(1),
        available: blockers.length === 0, blockers, connections });
    }
    return { harnesses, hosts };
  }

  function validate(payload, current) {
    const harness = current.harnesses.find(row => row.id === payload.harness);
    const model = harness?.connections.find(row => row.id === payload.connectionId)
      ?.models.find(row => row.id === payload.model);
    if (!harness?.available || !model) throw new Error('mod_minion_selection_unavailable');
    const host = current.hosts.find(row => row.id === payload.executionHostId);
    if (!host?.available || !host.harnesses?.find(row => row.id === payload.harness)?.available) {
      throw new Error('mod_minion_execution_host_unavailable');
    }
    if (payload.reasoningEffort !== null && !model.reasoningEfforts.includes(payload.reasoningEffort)) {
      throw new Error('mod_minion_reasoning_effort_unsupported');
    }
    return true;
  }

  async function execute(payload, { signal, jobId, ownerModId }) {
    validate(payload, await catalog({ executionHostIds: [payload.executionHostId] }));
    const selection = { connectionId: payload.connectionId, model: payload.model };
    let modelConfig;
    if (payload.harness === 'burrow') {
      modelConfig = await resolveModelConfig({ stores, modelConnectionId: payload.connectionId,
        model: payload.model, model_selection_snapshot: true,
        ...(payload.reasoningEffort !== null ? { model_reasoning_effort: payload.reasoningEffort } : {}) });
    } else {
      modelConfig = await VALIDATORS[payload.harness](stores.models, selection);
      if (payload.harness === 'codex' && payload.reasoningEffort !== null) {
        modelConfig = { ...modelConfig, extra: { reasoning: { effort: payload.reasoningEffort } } };
      }
    }
    const remote = payload.executionHostId === 'local' ? null : remoteHostId(payload.executionHostId);
    const controller = remote && executionProviders?.get?.(remote.providerId);
    if (remote && (!controller || typeof controller.describeHost !== 'function')) throw new Error('mod_minion_execution_host_unavailable');
    const processTarget = remote ? remoteExecutionTarget(remote.providerId, remote.targetId) : { kind: 'local' };
    const minionDepth = { depth: 1, maxDepth: (await readMinionSettings(stores.metadata, null)).maxDepth };
    const toolSchemas = nativeToolSchemas({ includeForge: false,
      includeSpawnSubagent: canSpawnMinion(minionDepth) });
    // No agent registry row, profile, personal history, or mod-supplied identity.
    // The deterministic namespace prevents transcripts from different mods mixing.
    const agentId = `core-mod-minion-${createHash('sha256').update(ownerModId).digest('hex')}`;
    if (typeof stores.minions?.ensureServicePrincipal !== 'function') throw new Error('mod_minion_service_identity_store_required');
    await stores.minions.ensureServicePrincipal(agentId);
    const owner = { agentId, sessionId: 'mod-minion-service', parentRunId: jobId,
      turnId: jobId, requestedBy: 'mod-minion-bridge' };
    const executionContext = createExecutionContext({
      conversationStore: stores.conversations, stores, sessionId: owner.sessionId, agentId,
      workspaceRoot: payload.target.root, target: payload.target, dataRoot: runtimeRoot,
      cacheRoot: path.join(runtimeRoot, 'cache'), minionDepth, toolSchemas,
      executionEnvironment: processTarget, processExecutionTarget: processTarget,
      processExecutionController: controller || null, executionProviders, telemetry, abortSignal: signal,
    });
    const target = remote ? await resolveRemoteTarget(payload.target, executionContext, jobId, signal)
      : await resolveExecutionTarget(payload.target);
    const id = jobId;
    const childSessionId = subagentChildSessionId(id);
    const traceDir = path.join(runtimeRoot, 'subagents', id, 'trace');
    const trace = { runId: id, childSessionId, traceDir };
    const model = { connectionId: selection.connectionId, model: selection.model };
    // The same existing policy used by a normal child; no bridge-specific
    // denylist. No commit control was requested, so commit remains disabled.
    const executionPolicy = createExecutionPolicy();
    const permissions = { mayRead: true, mayWrite: executionPolicy.mayMutate,
      mayExecute: true, mayNetwork: true, mayCommit: executionPolicy.mayCommit,
      allowedTools: executionContext.toolSchemas.map(tool => tool.function?.name).filter(Boolean),
      toolSurface: 'normal-runtime-tools' };
    await createSubagentRecord({ dataRoot: runtimeRoot, id, owner, purpose: payload.task,
      harness: payload.harness, scope: { target }, permissions,
      trace, model, provenance: ['generic-mod-minion', 'context:faceless'] });
    let started = false;
    try {
      const actualSession = await startSubagentChildSession({ dataRoot: runtimeRoot, id,
        workerProfile: 'mod_minion', harness: payload.harness, purpose: payload.task, owner,
        trace, model, conversationStore: stores.conversations });
      if (actualSession !== childSessionId) throw new Error('mod_minion_session_identity_mismatch');
      started = true;
      signal?.throwIfAborted();
      await updateSubagentStatus({ dataRoot: runtimeRoot, id, status: 'running', phase: 'spawned', trace });
      const result = await runSpawnSubagentChild({ harness: payload.harness, id, task: payload.task, target,
        dataRoot: runtimeRoot, childSessionId, owner, modelConfig, traceDir,
        preserveTerminalReport: true, workerProfile: 'mod_minion', executionPolicy,
        parentExecutionContext: executionContext, signal });
      const status = signal?.aborted ? 'cancelled' : result?.ok ? 'succeeded' : 'failed';
      await updateSubagentStatus({ dataRoot: runtimeRoot, id, status, phase: 'idle', result });
      await finishSubagentChildSession({ dataRoot: runtimeRoot, sessionId: childSessionId, id,
        workerProfile: 'mod_minion', owner, trace, status, model, result,
        finalReplyPersisted: payload.harness !== 'burrow' && result?.ok === true,
        preserveSummary: true, conversationStore: stores.conversations });
      return result;
    } catch (error) {
      // A worker exception or persistence failure must not leave a falsely
      // succeeded receipt. PostgreSQL records the durable error in the caller.
      if (started) {
        const status = signal?.aborted ? 'cancelled' : 'failed';
        const result = { ok: false, summary: 'Minion child did not complete.',
          blockers: ['mod_minion_child_failed'], warnings: [], evidence: [] };
        try {
          await updateSubagentStatus({ dataRoot: runtimeRoot, id, status, phase: 'idle', result });
          await finishSubagentChildSession({ dataRoot: runtimeRoot, sessionId: childSessionId, id,
            workerProfile: 'mod_minion', owner, trace, status, model, result, conversationStore: stores.conversations });
        } catch { /* The original error is retained in the PostgreSQL job. */ }
      }
      throw error;
    }
  }
  execute.validate = validate;
  return Object.freeze({ catalog, validate, execute });
}
