function unique(values = []) {
  return [...new Set((values || []).filter(Boolean))];
}

function normalizeAction(action = null) {
  const value = String(action || '').trim().toLowerCase();
  return value || null;
}

import { createModelAdapter } from './model-adapter.mjs';
import { normalizeProviderMessages } from './provider-messages.mjs';
import { selectCatalogSkills, skillManifest } from './skill-catalog.mjs';

function actionExecution(action = null) {
  const normalized = normalizeAction(action);
  if (!normalized) return { mode: 'chat', mayInspect: false, mayMutate: false, mayCommit: false };
  if (['inspect', 'read', 'plan'].includes(normalized)) return { mode: normalized === 'plan' ? 'plan' : 'inspect', mayInspect: true, mayMutate: false, mayCommit: false };
  if (['write', 'edit', 'patch', 'files_patch', 'delete', 'create', 'mutate', 'append'].includes(normalized)) return { mode: 'work', mayInspect: true, mayMutate: true, mayCommit: false };
  if (['factory', 'commit'].includes(normalized)) return { mode: 'factory', mayInspect: true, mayMutate: true, mayCommit: true };
  return { mode: 'chat', mayInspect: false, mayMutate: false, mayCommit: false };
}

const FILE_TARGET_EXTENSIONS = new Set(['md', 'markdown', 'mjs', 'js', 'json', 'ts', 'tsx', 'css', 'html', 'yml', 'yaml', 'txt', 'toml', 'env', 'sh']);

function looksLikeWorkspaceFileTarget(value = '') {
  const target = String(value || '').trim();
  if (!target || /\s/u.test(target)) return false;
  const basename = target.split(/[\\/]/u).pop() || target;
  const match = basename.match(/(?:^\.env$|^.+\.([a-z][a-z0-9]*)$)/iu);
  if (!match) return false;
  const extension = match[1] ? match[1].toLowerCase() : 'env';
  return FILE_TARGET_EXTENSIONS.has(extension);
}

function actionKind(action = null) {
  const normalized = normalizeAction(action);
  if (!normalized) return 'chat';
  if (['factory', 'commit'].includes(normalized)) return 'factory';
  if (['write', 'edit', 'patch', 'files_patch', 'delete', 'create', 'mutate', 'append'].includes(normalized)) return 'mutate';
  if (normalized === 'plan') return 'plan';
  if (['inspect', 'read'].includes(normalized)) return 'inspect';
  return 'chat';
}

function targetKind(target = null) {
  if (!target) return 'none';
  const value = String(target || '').trim();
  if (!value) return 'none';
  if (value === 'workspace') return 'workspace';
  if (looksLikeWorkspaceFileTarget(value)) return 'file';
  if (/^(?:\.\.?[\/]|[\/]|[a-z]:[\/])/iu.test(value)) return 'path';
  return 'natural-language';
}

function executionLevelForKind(kind = 'chat') {
  if (kind === 'factory') return 'commit';
  if (kind === 'mutate') return 'mutate';
  if (kind === 'inspect' || kind === 'plan') return 'inspect';
  return 'none';
}

function highestExecutionLevel(actions = []) {
  const order = { none: 0, inspect: 1, mutate: 2, commit: 3 };
  return (actions || []).reduce((highest, action) => (order[action.executionLevel] > order[highest] ? action.executionLevel : highest), 'none');
}

function structuredAction({ kind = 'chat', operation = null, target = null, source = 'default-chat', confidence = 'default' } = {}) {
  const resolvedKind = kind === 'mutation' ? 'mutate' : kind;
  return {
    kind: resolvedKind,
    operation: operation || null,
    target: target || null,
    targetKind: targetKind(target || null),
    executionLevel: executionLevelForKind(resolvedKind),
    source,
    confidence,
  };
}

function structuredPendingAction({ kind = 'mutate', operation = null, target = null, source = 'pending-action', confidence = 'recent-context' } = {}) {
  const resolvedKind = kind === 'mutation' ? 'mutate' : kind;
  if (!['inspect', 'plan', 'mutate', 'factory'].includes(resolvedKind)) return null;
  return {
    kind: resolvedKind,
    operation: operation || resolvedKind,
    target: target || null,
    targetKind: targetKind(target || null),
    executionLevel: executionLevelForKind(resolvedKind),
    source,
    confidence,
  };
}

function latestPendingActionsFromConversation(conversationContext = {}) {
  const turns = Array.isArray(conversationContext?.turns) ? [...conversationContext.turns].reverse() : [];
  const pending = [];
  for (const turn of turns) {
    const entries = [turn?.metadata?.pendingAction, ...(turn?.metadata?.pendingActions || [])].filter(Boolean);
    for (const entry of entries) {
      const action = normalizePendingAction(entry);
      if (action) pending.push({ ...action, turnId: turn.id || null, role: turn.role || null });
    }
    if (pending.length >= 8) break;
  }
  return pending.slice(0, 8);
}

function normalizePendingAction(action = null) {
  if (!action || typeof action !== 'object') return null;
  const operation = normalizeAction(action.operation || action.action || action.intent || action.kind);
  const kind = operationKind(operation, action.kind);
  const normalizedKind = kind === 'mutation' ? 'mutate' : kind;
  if (!['inspect', 'plan', 'mutate', 'factory'].includes(normalizedKind)) return null;
  return structuredPendingAction({
    kind: normalizedKind,
    operation: operation || normalizedKind,
    target: action.target === undefined || action.target === null || action.target === '' ? null : String(action.target),
    source: action.source || 'pending-action',
    confidence: action.confidence || 'recent-context',
  });
}

function actionsFromInstruction({ instruction = null, explicitAction = null, fallbackAction = null } = {}) {
  if (explicitAction) return [structuredAction({ kind: actionKind(explicitAction), operation: explicitAction, target: instruction?.target || null, source: 'explicit-action', confidence: 'explicit-control' })];
  if (Array.isArray(instruction?.actions) && instruction.actions.length) return instruction.actions;
  const resolvedAction = normalizeAction(fallbackAction || instruction?.action);
  const kind = actionKind(resolvedAction);
  if (!resolvedAction && kind === 'chat') return [];
  return [structuredAction({ kind, operation: resolvedAction, target: instruction?.target || null, source: instruction?.source || 'default-chat', confidence: instruction?.confidence || 'default' })];
}

function intentFacts({ action = null, instruction = null, explicitAction = null, advisoryOnly = false, readOnly = false, message = '' } = {}) {
  const actions = actionsFromInstruction({ instruction, explicitAction, fallbackAction: action });
  const executionLevel = highestExecutionLevel(actions);
  const primary = actions.find((item) => item.executionLevel === executionLevel) || actions[0] || null;
  const resolvedAction = normalizeAction(explicitAction || action || instruction?.action || primary?.operation);
  const kind = primary?.kind || actionKind(resolvedAction);
  const target = primary?.target || instruction?.target || null;
  const resolvedTargetKind = targetKind(target);
  const fileTargets = unique(actions.filter((item) => item.targetKind === 'file').map((item) => item.target));
  const source = explicitAction ? 'explicit-action' : instruction?.source || primary?.source || 'default-chat';
  const confidence = explicitAction ? 'explicit-control' : instruction?.confidence || primary?.confidence || 'default';
  const authoritative = Boolean(
    actions.length
    || resolvedAction
    || target
    || kind !== 'chat'
    || source !== 'default-chat'
    || confidence !== 'default'
  );
  return {
    version: 2,
    action: resolvedAction,
    kind,
    executionLevel,
    actions,
    target,
    targetKind: resolvedTargetKind,
    fileTargets,
    needsWorkspace: fileTargets.length > 0 || resolvedTargetKind === 'workspace' || resolvedTargetKind === 'path' || ['inspect', 'mutate', 'factory'].includes(kind) || ['inspect', 'mutate', 'commit'].includes(executionLevel),
    requiresGitStatus: false,
    source,
    confidence,
    authoritative,
    advisoryOnly: Boolean(advisoryOnly),
    readOnly: Boolean(readOnly),
  };
}

function explicitMemoryActionCue(message = '') {
  return /\b(?:check|search|use)\s+(?:your\s+)?memory\b|\blook\s+in\s+(?:your\s+)?memory\b/iu.test(String(message || ''));
}

function recallMetaFollowupMessage(message = '') {
  const text = String(message || '').trim();
  if (!text) return false;
  return /\b(?:that|this|it)\s+should\s+have\s+(?:retrieved|returned|found|matched)\b/iu.test(text)
    || /\b(?:retrieved|returned|found)\s+(?:nothing|empty|zero|0)\b/iu.test(text)
    || /\b(?:memory|recall|retrieval|brain)\s+(?:returned|retrieved|found|came\s+back|is\s+showing)\s+(?:empty|nothing|zero|0|\d+\s+(?:objects|rows|results))\b/iu.test(text)
    || /\b(?:why|how)\s+(?:did|does)\s+(?:memory|recall|retrieval|your\s+brain)\s+(?:miss|fail|return\s+empty|find\s+nothing)\b/iu.test(text)
    || /\b(?:wrong|bad|badly\s+formed|too\s+literal)\s+(?:memory|recall|retrieval)?\s*query\b/iu.test(text);
}

function genericProjectRecallMessage(message = '', alias = '') {
  const text = String(message || '').trim();
  const aliasWords = normalizedWords(alias);
  const words = normalizedWords(text);
  if (!text || !aliasWords.length) return false;
  const generic = new Set(['a', 'an', 'the', 'and', 'or', 'on', 'of', 'for', 'to', 'do', 'does', 'did', 'you', 'your', 'can', 'could', 'would', 'please', 'look', 'lookup', 'search', 'find', 'tell', 'info', 'information', 'have', 'has', 'know', 'known', 'remember', 'recall', 'memory', 'brain', 'about', 'me', 'what', 'which', 'anything', 'something', 'all', 'any', 'give', 'show']);
  const aliasSet = new Set(aliasWords);
  const substantive = words.filter((word) => !generic.has(word) && !aliasSet.has(word));
  return substantive.length === 0;
}

function normalizedWords(value = '') {
  return String(value || '').toLowerCase().split(/[^a-z0-9]+/u).filter(Boolean);
}

function aliasMatchText(text = '', knownProjects = []) {
  const words = normalizedWords(text);
  for (const entry of knownProjects || []) {
    const project = typeof entry === 'string' ? entry : entry?.project;
    const aliases = typeof entry === 'string' ? [entry] : (entry?.aliases || [project]);
    for (const alias of aliases.filter(Boolean)) {
      const aliasWords = normalizedWords(alias);
      if (aliasWords.length && aliasWords.length <= words.length) {
        for (let idx = 0; idx <= words.length - aliasWords.length; idx += 1) {
          if (aliasWords.every((word, offset) => words[idx + offset] === word)) return { topic: alias, project };
        }
      }
    }
  }
  return null;
}

function projectInventoryCue(message = '') {
  return /\b(?:what|which|are\s+there\s+any)\s+(?:memory\s+)?projects\s+(?:do\s+you\s+)?(?:know|have|remember|track|about|exist)?\b|\b(?:what|which|list|show)\s+(?:are\s+)?(?:the\s+)?(?:known|tracked)\s+projects\b|\bproject\s+(?:registry|inventory|list)\b|\bknown\s+projects\b/iu.test(String(message || ''));
}

function titleTopic(text = '') {
  const stop = new Set(['Should', 'Memory', 'Remember', 'Recall', 'What', 'Where', 'When', 'That', 'This', 'Your']);
  const matches = String(text || '').match(/\b[A-Z][a-z0-9]+(?:\s+[A-Z][a-z0-9]+){1,4}\b/gu) || [];
  for (const match of matches) {
    const first = match.split(/\s+/u)[0];
    if (!stop.has(first)) return match;
  }
  return null;
}

function explicitRecallTopic(message = '') {
  const match = String(message || '').match(/\brecall\s+([A-Z][A-Z0-9]{1,12}|[A-Z][a-z0-9]+(?:\s+[A-Z][a-z0-9]+){0,3})\b/u);
  if (!match) return null;
  const topic = match[1].trim();
  if (['I', 'The', 'That', 'This', 'Memory'].includes(topic)) return null;
  return topic;
}

function memoryPlan({ message = '', memoryContext = {} } = {}) {
  // The runtime carries structured memory context or a narrow explicit memory
  // control. It does not infer recall from project names or conversational form.
  const explicitCue = explicitMemoryActionCue(message);
  const explicitProjects = unique(memoryContext.projects || []);
  const topics = unique(memoryContext.topics || []);
  const query = memoryContext.query ? String(memoryContext.query) : (explicitCue ? String(message || '').trim() : null);
  const project = explicitProjects[0] || null;
  const scope = memoryContext.global ? { kind: 'global', project: null } : project ? { kind: 'project', project } : { kind: 'default', project: null };
  const enabled = Boolean(query || memoryContext.global || explicitProjects.length);
  const routingTerms = unique([...(memoryContext.routingTerms || [])]);
  const provenance = enabled ? [{ source: 'explicit-memory-context' }, ...(explicitCue && !memoryContext.query ? [{ source: 'explicit-memory-control', query }] : [])] : [];
  return {
    enabled,
    scope,
    query,
    originalQuery: memoryContext.originalQuery || query,
    resolvedQuery: query,
    routingTerms,
    intent: memoryContext.intent || null,
    allowNone: true,
    provenance,
    request: enabled ? { enabled: true, scope, query, originalQuery: memoryContext.originalQuery || query, resolvedQuery: query, routingTerms, intent: memoryContext.intent || null, allowNone: true, provenance } : null,
  };
}

function extraEyesPlan({ explicitControls = {}, workspaceContext = {} } = {}) {
  const explicitControl = explicitControls.extraEyes === true || explicitControls.extra_eyes === true;
  const requested = Boolean(explicitControl);
  const files = unique(workspaceContext.files || []);
  const workspaceRoot = workspaceContext.workspaceRoot || null;
  const blockers = [];
  if (requested && !files.length && !workspaceRoot) blockers.push('extra_eyes_explicit_files_required');
  return {
    requested,
    helper: 'validation-helper',
    workspaceRoot,
    files,
    blockers,
    provenance: requested ? [{ source: 'explicit-extra-eyes-control' }] : [],
  };
}

function workspacePlan(workspaceContext = {}) {
  const files = unique(workspaceContext.files || []);
  const root = workspaceContext.workspaceRoot || null;
  const include = Boolean(root || files.length);
  return {
    include,
    root,
    files,
    provenance: include ? [{ source: files.length ? 'explicit-workspace-files' : 'explicit-workspace-root' }] : [],
  };
}

function skillPlan({ skillIndex = {}, selectedIds = [] } = {}) {
  const catalog = Array.isArray(skillIndex.skills) ? skillIndex.skills : [];
  const selection = selectCatalogSkills({ catalog, ids: selectedIds, source: 'planner-selected' });
  return {
    selected: selection.selected,
    rejected: selection.rejected,
    catalog,
    provenance: selection.selected.map((skill) => ({ source: 'planner-selected-skill', skillId: skill.id, owner: skill.owner })),
  };
}

function routeDecisionSource({ session = null, explicitControls = {} } = {}) {
  if (explicitControls?.action) return { source: 'explicit-control', confidence: 'explicit-control' };
  if (session?.kind && session.kind !== 'answer') return { source: 'explicit-control', confidence: session.reason || 'explicit-session' };
  return { source: 'runtime-chat', confidence: 'tool-capable-chat' };
}

export function createRouteDecision({ session = null, turnPlan = null, route = null, explicitControls = {} } = {}) {
  const source = routeDecisionSource({ session, explicitControls });
  const action = explicitControls?.action || null;
  const blockers = unique([
    ...(turnPlan?.observability?.blockers || []),
    ...(turnPlan?.safety?.blockers || []),
    ...(session?.blockers || []),
  ]);
  const warnings = unique([
    ...(turnPlan?.safety?.warnings || []),
    ...(session?.warnings || []),
    ...(route?.action?.review?.warnings || []),
  ]);

  return {
    version: 1,
    sessionKind: session?.kind || 'answer',
    routeKind: session?.kind || 'answer',
    action,
    reason: session?.reason || 'plain_chat',
    source: source.source,
    confidence: source.confidence,
    explicitControls: {
      action: explicitControls?.action || null,
      extraEyes: Boolean(explicitControls?.extraEyes),
      continueWork: Boolean(explicitControls?.continueWork || explicitControls?.continue_work),
    },
    signals: turnPlan?.observability?.signals || [],
    blockers,
    warnings,
  };
}

function executionForLevel(executionLevel = 'none') {
  if (executionLevel === 'commit') return { mode: 'factory', mayInspect: true, mayMutate: true, mayCommit: true };
  if (executionLevel === 'mutate') return { mode: 'work', mayInspect: true, mayMutate: true, mayCommit: false };
  if (executionLevel === 'inspect') return { mode: 'inspect', mayInspect: true, mayMutate: false, mayCommit: false };
  return { mode: 'chat', mayInspect: false, mayMutate: false, mayCommit: false };
}

function operationKind(operation = null, fallbackKind = null) {
  const normalized = normalizeAction(operation);
  if (fallbackKind) {
    const kind = String(fallbackKind).toLowerCase();
    if (kind === 'mutation') return 'mutate';
    if (['chat', 'inspect', 'plan', 'mutate', 'factory'].includes(kind)) return kind;
  }
  return actionKind(normalized);
}

function normalizePlannerAction(action = {}, index = 0) {
  const operation = normalizeAction(action.operation || action.action || action.intent || action.kind);
  const kind = operationKind(operation, action.kind);
  const normalizedKind = kind === 'mutation' ? 'mutate' : kind;
  if (!['inspect', 'plan', 'mutate', 'factory'].includes(normalizedKind)) return { ok: false, error: `action_${index}:invalid_kind`, action: null };
  const target = action.target === undefined || action.target === null || action.target === '' ? null : String(action.target);
  return {
    ok: true,
    action: structuredAction({
      kind: normalizedKind,
      operation: operation || normalizedKind,
      target,
      source: action.source || 'llm',
      confidence: action.confidence || 'model-planned',
    }),
  };
}

function parsePlannerJson(text = '') {
  const raw = String(text || '').trim();
  const candidate = raw.startsWith('```') ? raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '') : raw;
  try { return JSON.parse(candidate); } catch { return null; }
}

function validatePlannerResponse(data = null, { message = '', pendingActions = [] } = {}) {
  if (!data || typeof data !== 'object') return { ok: false, error: 'planner_invalid_json', actions: [] };
  if (!Array.isArray(data.actions)) return { ok: false, error: 'planner_actions_required', actions: [] };
  const normalized = data.actions.map(normalizePlannerAction);
  const errors = normalized.filter((item) => !item.ok).map((item) => item.error);
  if (errors.length) return { ok: false, error: errors.join(','), actions: [] };
  const actions = normalized.map((item) => item.action);
  const pendingAction = normalizePendingAction(data.pendingAction || null);
  const memory = data.memory && typeof data.memory === 'object' ? {
    resolvedQuery: data.memory.resolvedQuery === undefined || data.memory.resolvedQuery === null || data.memory.resolvedQuery === '' ? null : String(data.memory.resolvedQuery),
    originalQuery: data.memory.originalQuery === undefined || data.memory.originalQuery === null || data.memory.originalQuery === '' ? null : String(data.memory.originalQuery),
    routingTerms: unique(data.memory.routingTerms || []).map(String),
  } : null;
  const support = data.support && typeof data.support === 'object' ? data.support : null;
  const skillIds = unique(data.skillIds || data.skill_ids || support?.skillIds || support?.skill_ids || []).map(String);
  return {
    ok: true,
    actions,
    pendingAction,
    memory,
    // Legacy planner support is accepted only for non-executing observability by callers that choose to inspect raw model output.
    // It must not become turn-plan support or delegated execution signal.
    support: null,
    ignoredSupport: support,
    skillIds,
    readOnly: Boolean(data.readOnly),
    advisoryOnly: Boolean(data.advisoryOnly),
    confidence: data.confidence ? String(data.confidence) : 'model-planned',
  };
}

function plannerPrompt({ message = '', workspaceContext = {}, conversationContext = {}, explicitAction = null, skillCatalog = [] } = {}) {
  const pendingActions = latestPendingActionsFromConversation(conversationContext);
  return [
    'You are Burrow TurnPlanner, the model planning phase for one turn. Extract requested user actions and optional skill IDs as JSON only.',
    'Return schema: {"actions":[{"kind":"inspect|plan|mutate|factory","operation":"inspect|read|append|write|edit|patch|delete|create|plan|factory","target":string|null}],"pendingAction":{"kind":"inspect|mutate","operation":"inspect|read|append|write|edit|patch|delete|create","target":string|null}|null,"memory":{"resolvedQuery":string|null,"originalQuery":string|null,"routingTerms":[string]}|null,"skillIds":[string],"readOnly":boolean,"advisoryOnly":boolean,"confidence":"model-planned"}',
    'If the user asks to inspect/read/review and then change/edit/write/append, include both actions. The execution level will be derived later from the highest action level.',
    'Use recent pending structured actions for context-dependent continuations like "ok do it". For a continuation inspect or mutation, the action target must match a recent pending action target exactly.',
    'If the user only clarifies the target/path for a pending action without explicitly approving execution, return no mutate action and return the updated pendingAction.',
    'If the user says do not change, propose only inspect/plan actions and set readOnly true.',
    'If the user asks to send/spawn/dispatch subagents or extra-eyes review, do not create support child-work plans. Extract only the underlying requested action/target. A first-class selected runtime tool will own child work later.',
    'For memory/retrieval turns, memory.resolvedQuery must be the focused subject to search. Preserve the literal current user text in memory.originalQuery when the current text is a meta comment about failed recall. Do not use meta complaints like "that should have retrieved something" as resolvedQuery when a prior subject exists.',
    'Do not include tool calls. Do not decide permission. You may select from the provided ownership-derived catalog, but selection grants no authority. Extract intent only.',
    `Explicit action control: ${explicitAction || '(none)'}`,
    `Workspace root available: ${workspaceContext.workspaceRoot ? 'yes' : 'no'}`,
    `Known files: ${(workspaceContext.files || []).join(', ') || '(none)'}`,
    `Recent pending structured actions: ${pendingActions.length ? JSON.stringify(pendingActions.map(({ turnId, role, ...action }) => action)) : '(none)'}`,
    `Effective skill catalog (ownership-derived manifests; choose ids only when useful): ${JSON.stringify(skillCatalog.map(skillManifest))}`,
    'Skills are visible because their owner makes them available. Do not infer, activate, or route skills from prose; choose zero or more ids only for this turn.',
    '',
    'User message:',
    String(message || ''),
  ].join('\n');
}

function plannerMemoryOverlay(baseMemory = {}, memory = null, { source = 'llm' } = {}) {
  if (!memory?.resolvedQuery) return baseMemory;
  const query = String(memory.resolvedQuery);
  const routingTerms = unique([...(baseMemory.routingTerms || []), ...(memory.routingTerms || [])]);
  const originalQuery = memory.originalQuery || baseMemory.originalQuery || null;
  const scope = baseMemory.scope || { kind: 'default', project: null };
  const provenance = [
    ...(baseMemory.provenance || []),
    { source: `${source}-memory-resolved-query`, query, originalQuery, routingTerms },
  ];
  const next = {
    ...baseMemory,
    enabled: true,
    scope,
    query,
    originalQuery,
    resolvedQuery: query,
    routingTerms,
    provenance,
  };
  next.request = {
    ...(baseMemory.request || {}),
    enabled: true,
    scope,
    query,
    originalQuery,
    resolvedQuery: query,
    routingTerms,
    intent: baseMemory.intent || null,
    allowNone: baseMemory.allowNone !== false,
    provenance,
  };
  return next;
}

function applyStructuredActionsToPlan(basePlan, { actions = [], pendingAction = null, memory = null, support = null, skillIds = [], workspaceContext = {}, source = 'llm', confidence = 'model-planned', readOnly = false, advisoryOnly = false, fallbackReason = null, message = '' } = {}) {
  const executionLevel = highestExecutionLevel(actions);
  const primary = actions.find((item) => item.executionLevel === executionLevel) || actions[0] || null;
  const execution = executionForLevel(executionLevel);
  const instruction = actions.length ? {
    action: primary?.operation || null,
    kind: primary?.kind === 'mutate' ? 'mutation' : primary?.kind || 'chat',
    confidence,
    target: primary?.target || null,
    source,
    actions,
  } : null;
  const facts = intentFacts({ action: primary?.operation || null, instruction, advisoryOnly, readOnly, message });
  let resolvedSupport = memory?.resolvedQuery ? { ...(basePlan.support || {}), memory: plannerMemoryOverlay(basePlan.support?.memory || {}, memory, { source }) } : { ...(basePlan.support || {}) };
  resolvedSupport = { ...resolvedSupport, skills: skillPlan({ skillIndex: { skills: basePlan.support?.skills?.catalog || [] }, selectedIds: skillIds }) };
  return {
    ...basePlan,
    mode: execution.mode,
    instruction,
    execution,
    support: resolvedSupport,
    intentFacts: { ...facts, plannerSource: source, fallbackReason, pendingAction: pendingAction || null },
    observability: {
      ...basePlan.observability,
      mode: execution.mode,
      action: primary?.operation || null,
      source,
      confidence,
      signals: [
        ...(basePlan.observability?.signals || []),
        { source, area: 'planner', action: primary?.operation || null, target: primary?.target || null, confidence },
      ],
      warnings: [...(basePlan.observability?.warnings || []), ...(fallbackReason ? [`planner_fallback:${fallbackReason}`] : [])],
    },
    provenance: [
      { source, action: primary?.operation || null, target: primary?.target || null, confidence, fallbackReason },
      ...(basePlan.provenance || []),
    ],
    safety: {
      ...(basePlan.safety || {}),
      warnings: [...(basePlan.safety?.warnings || []), ...(fallbackReason ? [`planner_fallback:${fallbackReason}`] : [])],
    },
  };
}

export async function planTurnWithModel({ modelAdapter = null, modelConfig = null, traceLogger = null, ...args } = {}) {
  const fallbackPlan = planTurn(args);
  const pendingActions = latestPendingActionsFromConversation(args.conversationContext || {});
  const plannerConfig = modelConfig?.planner || modelConfig?.planning || null;
  const adapter = modelAdapter || (plannerConfig?.baseUrl ? createModelAdapter({ config: plannerConfig }) : null);
  if (!adapter) {
    if (!plannerConfig && !modelAdapter) return fallbackPlan;
    await traceLogger?.router?.({ stage: 'planner', plannerSource: 'empty-fallback', reason: 'model_unavailable' });
    return applyStructuredActionsToPlan(fallbackPlan, {
      actions: fallbackPlan.intentFacts?.actions || [],
      source: 'empty-fallback',
      confidence: fallbackPlan.intentFacts?.confidence || 'fallback',
      readOnly: fallbackPlan.intentFacts?.readOnly || false,
      advisoryOnly: fallbackPlan.intentFacts?.advisoryOnly || false,
      fallbackReason: 'model_unavailable',
      message: args.message || '',
    });
  }
  try {
    const explicitAction = normalizeAction(args.explicitControls?.action ?? args.action);
    const model = await adapter.complete({ messages: normalizeProviderMessages([{ role: 'user', content: plannerPrompt({ message: args.message, workspaceContext: args.workspaceContext || {}, conversationContext: args.conversationContext || {}, explicitAction, skillCatalog: args.skillIndex?.skills || [] }), metadata: { providerMessageSource: 'internal-planner' } }]), temperature: 0, maxTokens: 500, traceLogger });
    const validation = validatePlannerResponse(parsePlannerJson(model?.choice?.text || ''), { message: args.message, pendingActions });
    if (!model?.ok || !validation.ok) {
      const reason = model?.ok ? validation.error : `model_error:${model?.error || 'unknown'}`;
      await traceLogger?.router?.({ stage: 'planner', plannerSource: 'empty-fallback', reason });
      return applyStructuredActionsToPlan(fallbackPlan, {
        actions: fallbackPlan.intentFacts?.actions || [],
        source: 'empty-fallback',
        confidence: fallbackPlan.intentFacts?.confidence || 'fallback',
        readOnly: fallbackPlan.intentFacts?.readOnly || false,
        advisoryOnly: fallbackPlan.intentFacts?.advisoryOnly || false,
        fallbackReason: reason,
        message: args.message || '',
      });
    }
    await traceLogger?.router?.({ stage: 'planner', plannerSource: 'llm', actionCount: validation.actions.length });
    return applyStructuredActionsToPlan(fallbackPlan, {
      actions: validation.actions,
      pendingAction: validation.pendingAction,
      memory: validation.memory,
      support: validation.support,
      skillIds: validation.skillIds,
      workspaceContext: args.workspaceContext || {},
      source: 'llm',
      confidence: validation.confidence,
      readOnly: validation.readOnly || fallbackPlan.intentFacts?.readOnly || false,
      advisoryOnly: validation.advisoryOnly || fallbackPlan.intentFacts?.advisoryOnly || false,
      message: args.message || '',
    });
  } catch (error) {
    const reason = `planner_exception:${error?.message || error}`;
    await traceLogger?.router?.({ stage: 'planner', plannerSource: 'empty-fallback', reason });
    return applyStructuredActionsToPlan(fallbackPlan, {
      actions: fallbackPlan.intentFacts?.actions || [],
      source: 'empty-fallback',
      confidence: fallbackPlan.intentFacts?.confidence || 'fallback',
      readOnly: fallbackPlan.intentFacts?.readOnly || false,
      advisoryOnly: fallbackPlan.intentFacts?.advisoryOnly || false,
      fallbackReason: reason,
      message: args.message || '',
    });
  }
}

export function planTurn({
  message = '',
  action = null,
  explicitControls = {},
  memoryContext = {},
  conversationContext = {},
  workspaceContext = {},
  skillConfig = {},
  skillIndex = {},
  agentRuntime = null,
} = {}) {
  // No prose classifier owns a turn. Fallback labels come only from an
  // explicit transport action; otherwise the model interprets the message.
  const advisoryOnly = false;
  const readOnly = false;
  const instruction = null;
  const explicitAction = normalizeAction(explicitControls.action ?? action);
  const plannedAction = explicitAction || null;
  const executionBase = actionExecution(plannedAction);
  const memory = memoryPlan({ message, memoryContext, conversationContext, agentRuntime });
  const workspace = workspacePlan(workspaceContext);
  const extraEyes = extraEyesPlan({ message, explicitControls, workspaceContext });
  const skills = skillPlan({ skillIndex, selectedIds: [] });
  const provenance = [];
  if (explicitAction) provenance.push({ source: 'explicit-action', action: explicitAction });
  if (!explicitAction && instruction) provenance.push({ source: instruction.source, action: instruction.action, target: instruction.target, confidence: instruction.confidence });
  provenance.push(...memory.provenance.map((item) => ({ ...item, area: 'memory' })));
  provenance.push(...workspace.provenance.map((item) => ({ ...item, area: 'workspace' })));
  provenance.push(...extraEyes.provenance.map((item) => ({ ...item, area: 'extra-eyes' })));
  provenance.push(...skills.provenance.map((item) => ({ ...item, area: 'skills' })));
  if (extraEyes.requested && !plannedAction) executionBase.mayInspect = true;
  const observabilitySource = explicitAction
    ? 'explicit-action'
    : instruction?.source || extraEyes.provenance[0]?.source || 'default-chat';
  const observabilityConfidence = explicitAction
    ? 'explicit-control'
    : instruction?.confidence || (extraEyes.requested ? 'explicit-control' : 'default');
  const facts = intentFacts({ action: plannedAction, instruction, explicitAction, advisoryOnly, readOnly, message });
  const observability = {
    mode: executionBase.mode,
    action: plannedAction,
    source: observabilitySource,
    confidence: observabilityConfidence,
    signals: provenance.map((item) => ({
      source: item.source || null,
      area: item.area || null,
      action: item.action || null,
      target: item.target || null,
      confidence: item.confidence || null,
    })),
    blockers: [...extraEyes.blockers],
  };

  return {
    version: 1,
    message: String(message || ''),
    mode: executionBase.mode,
    explicitControls: {
      ...(explicitControls || {}),
      action: explicitAction,
    },
    instruction,
    support: {
      memory,
      skills,
      workspace,
      extraEyes,
    },
    execution: {
      mayInspect: executionBase.mayInspect,
      mayMutate: executionBase.mayMutate,
      mayCommit: executionBase.mayCommit,
    },
    safety: {
      blockers: [],
      warnings: [],
      needsQuestion: false,
    },
    advisory: {
      incidentalCueRouting: false,
    },
    observability,
    intentFacts: facts,
    provenance,
  };
}

export function enrichTurnPlan(baseTurnPlan, {
  message = baseTurnPlan?.message || '',
  action = null,
  explicitControls = {},
  memoryContext = {},
  conversationContext = {},
  workspaceContext = {},
  skillConfig = {},
  skillIndex = {},
  agentRuntime = null,
} = {}) {
  const enriched = planTurn({
    message,
    action,
    explicitControls,
    memoryContext,
    conversationContext,
    workspaceContext,
    skillConfig,
    skillIndex,
    agentRuntime,
  });

  const support = {
    ...enriched.support,
    ...(baseTurnPlan?.support || {}),
    // Planner-labeled selection survives enrichment; enrichment must not re-select from text/config.
    skills: baseTurnPlan?.support?.skills || enriched.support?.skills || { selected: [], catalog: [], rejected: [], provenance: [] },
  };

  return {
    ...enriched,
    mode: baseTurnPlan?.mode || enriched.mode,
    instruction: baseTurnPlan?.instruction || null,
    support,
    intentFacts: baseTurnPlan?.intentFacts ? { ...baseTurnPlan.intentFacts } : null,
    execution: baseTurnPlan?.execution || enriched.execution,
    observability: {
      ...enriched.observability,
      mode: baseTurnPlan?.observability?.mode || baseTurnPlan?.mode || enriched.observability.mode,
      action: baseTurnPlan?.observability?.action || baseTurnPlan?.intentFacts?.action || enriched.observability.action,
      source: baseTurnPlan?.observability?.source || enriched.observability.source,
      confidence: baseTurnPlan?.observability?.confidence || enriched.observability.confidence,
    },
    provenance: [
      ...(baseTurnPlan?.provenance || []),
      ...enriched.provenance.filter((item) => item.area === 'skills'),
    ],
  };
}

export const __test__ = { actionExecution, actionKind, targetKind, looksLikeWorkspaceFileTarget, intentFacts, memoryPlan, workspacePlan, extraEyesPlan, skillPlan, routeDecisionSource, validatePlannerResponse, parsePlannerJson, applyStructuredActionsToPlan };
