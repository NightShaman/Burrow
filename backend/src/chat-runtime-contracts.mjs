const CHAT_TURN_KIND = 'chat';

export const CHAT_RUNTIME_CONTRACT_VERSION = 1;

export const TURN_CAPABILITIES = Object.freeze([
  'answer',
  'inspect',
  'edit',
  'verify',
  'commit-preview',
  'memory',
]);

export const EXECUTION_CAPABILITIES = Object.freeze([
  'readWorkspace',
  'mutateWorkspace',
  'commit',
]);

export const BOUNDARY_STATES = Object.freeze([
  'safe',
  'blocked',
]);

export const SIDE_CHANNEL_TYPES = Object.freeze([
  'event',
  'receipt',
  'tool',
  'debug',
]);

export const RUNTIME_TURN_KIND = 'runtime-turn';
export const CANONICAL_TURN_ENVELOPE_KIND = 'canonical-turn-envelope';

export const PROMPT_SECTION_ORDER = Object.freeze([
  'conversation',
  'prior-conversation-summary',
  'support-memory',
  'skills',
  'current-message',
]);

function uniqueKnown(values = [], known = []) {
  const allowed = new Set(known);
  return [...new Set((Array.isArray(values) ? values : [values]).filter(Boolean).map(String))]
    .filter((value) => allowed.has(value));
}

function enumValue(value, known, fallback) {
  return known.includes(value) ? value : fallback;
}

function compactString(value) {
  return String(value || '').trim();
}

function normalizeCapabilities(capabilities = {}) {
  const normalized = capabilities && typeof capabilities === 'object' ? { ...capabilities } : {};
  normalized.readWorkspace = Boolean(normalized.readWorkspace);
  normalized.mutateWorkspace = Boolean(normalized.mutateWorkspace);
  normalized.commit = Boolean(normalized.commit);
  return normalized;
}

function executionCapabilitiesFromPolicy(executionPolicy = {}) {
  if (executionPolicy?.capabilities && typeof executionPolicy.capabilities === 'object') {
    return normalizeCapabilities(executionPolicy.capabilities);
  }
  return {
    readWorkspace: Boolean(executionPolicy?.mayInspect),
    mutateWorkspace: Boolean(executionPolicy?.mayMutate),
    commit: Boolean(executionPolicy?.mayCommit),
  };
}

export function createChatTurnInput({
  sessionId = 'default',
  message,
  channel = 'web',
  capabilities = ['answer'],
  boundary = 'safe',
  workspaceRoot = null,
  metadata = {},
} = {}) {
  return {
    contractVersion: CHAT_RUNTIME_CONTRACT_VERSION,
    kind: CHAT_TURN_KIND,
    sessionId: compactString(sessionId) || 'default',
    channel: compactString(channel) || 'web',
    message: compactString(message),
    capabilities: uniqueKnown(capabilities, TURN_CAPABILITIES),
    boundary: enumValue(boundary, BOUNDARY_STATES, 'safe'),
    workspaceRoot: workspaceRoot ? String(workspaceRoot) : null,
    metadata: metadata && typeof metadata === 'object' ? { ...metadata } : {},
  };
}

function normalizePlanner(planner = null) {
  return planner ? {
    mode: planner.mode || 'chat',
    execution: planner.execution || {},
    support: planner.support || {},
    instruction: planner.instruction || null,
    intentFacts: planner.intentFacts || null,
    provenance: Array.isArray(planner.provenance) ? planner.provenance : [],
  } : null;
}

function normalizeRouteDecision(routeDecision = null) {
  return routeDecision && typeof routeDecision === 'object' ? {
    version: routeDecision.version || 1,
    sessionKind: routeDecision.sessionKind || routeDecision.routeKind || 'chat',
    routeKind: routeDecision.routeKind || routeDecision.sessionKind || 'chat',
    action: routeDecision.action || null,
    reason: routeDecision.reason || null,
    source: routeDecision.source || null,
    confidence: routeDecision.confidence || null,
    explicitControls: routeDecision.explicitControls && typeof routeDecision.explicitControls === 'object' ? { ...routeDecision.explicitControls } : {},
    signals: Array.isArray(routeDecision.signals) ? routeDecision.signals : [],
    blockers: Array.isArray(routeDecision.blockers) ? routeDecision.blockers : [],
    warnings: Array.isArray(routeDecision.warnings) ? routeDecision.warnings : [],
  } : null;
}

function normalizeExecutionPolicy(executionPolicy = {}) {
  const normalizedExecutionCapabilities = executionCapabilitiesFromPolicy(executionPolicy);
  const hasExplicit = (key) => Object.prototype.hasOwnProperty.call(executionPolicy || {}, key);
  if (hasExplicit('mayInspect') && Boolean(executionPolicy.mayInspect) !== normalizedExecutionCapabilities.readWorkspace) throw new Error('executionPolicy mayInspect conflicts with capabilities.readWorkspace');
  if (hasExplicit('mayMutate') && Boolean(executionPolicy.mayMutate) !== normalizedExecutionCapabilities.mutateWorkspace) throw new Error('executionPolicy mayMutate conflicts with capabilities.mutateWorkspace');
  if (hasExplicit('mayCommit') && Boolean(executionPolicy.mayCommit) !== normalizedExecutionCapabilities.commit) throw new Error('executionPolicy mayCommit conflicts with capabilities.commit');
  return executionPolicy && typeof executionPolicy === 'object' ? {
    ...executionPolicy,
    capabilities: normalizedExecutionCapabilities,
    mayInspect: normalizedExecutionCapabilities.readWorkspace,
    mayMutate: normalizedExecutionCapabilities.mutateWorkspace,
    mayCommit: normalizedExecutionCapabilities.commit,
  } : { capabilities: normalizedExecutionCapabilities };
}

export function createCanonicalTurnEnvelope({
  sessionId = 'default',
  conversationId = null,
  message = '',
  input = {},
  route = {},
  planner = null,
  context = {},
  executionPolicy = {},
  support = {},
  trace = {},
  routeDecision = null,
} = {}) {
  const compactSessionId = compactString(sessionId) || 'default';
  return {
    contractVersion: CHAT_RUNTIME_CONTRACT_VERSION,
    kind: CANONICAL_TURN_ENVELOPE_KIND,
    rootPrimitive: CHAT_TURN_KIND,
    sessionId: compactSessionId,
    conversationId: compactString(conversationId) || null,
    message: compactString(message),
    input: input && typeof input === 'object' ? { ...input } : {},
    route: route && typeof route === 'object' ? { ...route } : {},
    routeDecision: normalizeRouteDecision(routeDecision),
    planner: normalizePlanner(planner),
    context: context && typeof context === 'object' ? { ...context } : {},
    executionPolicy: normalizeExecutionPolicy(executionPolicy),
    support: support && typeof support === 'object' ? { ...support } : {},
    trace: { ...(trace && typeof trace === 'object' ? trace : {}), sessionId: trace?.sessionId || compactSessionId },
  };
}

export function createRuntimeTurnContract({
  sessionId = 'default',
  message = '',
  planner = null,
  context = {},
  executionPolicy = {},
  support = {},
  trace = {},
  envelope = null,
} = {}) {
  const source = envelope && typeof envelope === 'object' ? envelope : null;
  return {
    contractVersion: CHAT_RUNTIME_CONTRACT_VERSION,
    kind: RUNTIME_TURN_KIND,
    rootPrimitive: CHAT_TURN_KIND,
    sessionId: compactString(source?.sessionId || sessionId) || 'default',
    message: compactString(source?.message || message),
    envelopeKind: source?.kind || undefined,
    routeDecision: normalizeRouteDecision(source?.routeDecision),
    planner: normalizePlanner(source?.planner || planner),
    context: source?.context && typeof source.context === 'object' ? { ...source.context } : (context && typeof context === 'object' ? { ...context } : {}),
    executionPolicy: normalizeExecutionPolicy(source?.executionPolicy || executionPolicy),
    support: source?.support && typeof source.support === 'object' ? { ...source.support } : (support && typeof support === 'object' ? { ...support } : {}),
    trace: source?.trace && typeof source.trace === 'object' ? { ...source.trace } : (trace && typeof trace === 'object' ? { ...trace } : {}),
  };
}

export function createContextEngineResult({
  recentMessages = [],
  priorSummary = '',
  support = {},
  promptSections = [],
  stats = {},
  sideChannelExclusions = {},
} = {}) {
  return {
    contractVersion: CHAT_RUNTIME_CONTRACT_VERSION,
    engine: 'ContextEngine',
    rootPrimitive: CHAT_TURN_KIND,
    promptSectionOrder: [...PROMPT_SECTION_ORDER],
    recentMessages: Array.isArray(recentMessages) ? recentMessages : [],
    priorSummary: String(priorSummary || ''),
    support: support && typeof support === 'object' ? { ...support } : {},
    promptSections: Array.isArray(promptSections) ? promptSections : [],
    stats: stats && typeof stats === 'object' ? { ...stats } : {},
    sideChannelExclusions: sideChannelExclusions && typeof sideChannelExclusions === 'object' ? { ...sideChannelExclusions } : {},
  };
}

export function createRuntimeTurnResult({
  finalText = '',
  blocker = null,
  sideChannels = [],
  evidence = [],
  needsUserInput = false,
  metadata = {},
} = {}) {
  return {
    contractVersion: CHAT_RUNTIME_CONTRACT_VERSION,
    orchestrator: 'RuntimeOrchestrator',
    rootPrimitive: CHAT_TURN_KIND,
    finalText: String(finalText || ''),
    blocker: blocker ? String(blocker) : null,
    needsUserInput: Boolean(needsUserInput),
    sideChannels: normalizeSideChannels(sideChannels),
    evidence: Array.isArray(evidence) ? evidence : [],
    metadata: metadata && typeof metadata === 'object' ? { ...metadata } : {},
  };
}

function normalizeSideChannels(sideChannels = []) {
  if (!Array.isArray(sideChannels)) return [];
  return sideChannels
    .map((entry) => {
      const type = enumValue(String(entry?.type || ''), SIDE_CHANNEL_TYPES, null);
      if (!type) return null;
      return {
        type,
        visibility: type === 'event' ? 'activity' : 'debug',
        content: entry?.content ?? null,
        metadata: entry?.metadata && typeof entry.metadata === 'object' ? { ...entry.metadata } : {},
      };
    })
    .filter(Boolean);
}

export function assertChatTurnInputContract(turn) {
  if (turn?.kind !== CHAT_TURN_KIND) throw new Error('chat turn contract requires kind="chat"');
  if (!compactString(turn.message)) throw new Error('chat turn contract requires message');
  if (!Array.isArray(turn.capabilities)) throw new Error('chat turn contract requires capabilities array');
  if (!BOUNDARY_STATES.includes(turn.boundary)) throw new Error(`unknown boundary state: ${turn.boundary}`);
  return true;
}

export function assertContextEngineContract(context) {
  if (context?.rootPrimitive !== CHAT_TURN_KIND) throw new Error('context engine contract requires chat root primitive');
  if (!Array.isArray(context.recentMessages)) throw new Error('context engine contract requires recentMessages array');
  if (!Array.isArray(context.promptSectionOrder)) throw new Error('context engine contract requires promptSectionOrder');
  const order = context.promptSectionOrder.join('\n');
  if (order !== PROMPT_SECTION_ORDER.join('\n')) throw new Error('context engine prompt section order changed');
  return true;
}

export function assertCanonicalTurnEnvelope(envelope) {
  if (envelope?.kind !== CANONICAL_TURN_ENVELOPE_KIND) throw new Error('canonical turn envelope requires kind="canonical-turn-envelope"');
  if (envelope?.rootPrimitive !== CHAT_TURN_KIND) throw new Error('canonical turn envelope requires chat root primitive');
  if (!compactString(envelope.message)) throw new Error('canonical turn envelope requires message');
  if (!envelope.routeDecision || typeof envelope.routeDecision !== 'object') throw new Error('canonical turn envelope requires routeDecision');
  if (!envelope.planner || typeof envelope.planner !== 'object') throw new Error('canonical turn envelope requires planner');
  if (!envelope.context || typeof envelope.context !== 'object') throw new Error('canonical turn envelope requires context');
  if (!envelope.executionPolicy || typeof envelope.executionPolicy !== 'object') throw new Error('canonical turn envelope requires executionPolicy');
  if (!envelope.trace || typeof envelope.trace !== 'object') throw new Error('canonical turn envelope requires trace');
  return true;
}

export function assertRuntimeTurnContract(contract) {
  if (contract?.kind !== RUNTIME_TURN_KIND) throw new Error('runtime turn contract requires kind="runtime-turn"');
  if (contract?.rootPrimitive !== CHAT_TURN_KIND) throw new Error('runtime turn contract requires chat root primitive');
  if (!compactString(contract.message)) throw new Error('runtime turn contract requires message');
  if (!contract.planner || typeof contract.planner !== 'object') throw new Error('runtime turn contract requires planner envelope');
  if (!contract.executionPolicy || typeof contract.executionPolicy !== 'object') throw new Error('runtime turn contract requires executionPolicy');
  return true;
}

export function assertRuntimeTurnResultContract(result) {
  if (result?.rootPrimitive !== CHAT_TURN_KIND) throw new Error('runtime result contract requires chat root primitive');
  if (!compactString(result.finalText) && !result.blocker) throw new Error('runtime result contract requires finalText or blocker');
  if (!Array.isArray(result.sideChannels)) throw new Error('runtime result contract requires sideChannels array');
  for (const entry of result.sideChannels) {
    if (!SIDE_CHANNEL_TYPES.includes(entry.type)) throw new Error(`unknown side-channel type: ${entry.type}`);
  }
  return true;
}

export const __contract__ = Object.freeze({
  chatTurnKind: CHAT_TURN_KIND,
  runtimeTurnKind: RUNTIME_TURN_KIND,
  canonicalTurnEnvelopeKind: CANONICAL_TURN_ENVELOPE_KIND,
  turnCapabilities: TURN_CAPABILITIES,
  boundaryStates: BOUNDARY_STATES,
  sideChannelTypes: SIDE_CHANNEL_TYPES,
  promptSectionOrder: PROMPT_SECTION_ORDER,
});
