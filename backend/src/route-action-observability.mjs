const DESTRUCTIVE_BOUNDARY_CUES = ['delete', 'remove', 'clean up', 'cleanup', 'wipe', 'destroy', 'drop', 'truncate', 'format', 'reset'];
const WORKSPACE_ACTIONS = ['inspect', 'read', 'write', 'edit', 'patch', 'delete', 'create', 'mutate'];
const LOCAL_WORK_CUES = ['repo', 'repository', 'workspace', 'working tree'];

function normalize(value) {
  return String(value || '').toLowerCase();
}

function cueMatches(text, cue) {
  const lower = normalize(text);
  const escaped = String(cue).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(`(^|[^a-z0-9_])${escaped}([^a-z0-9_]|$)`, 'i').test(lower);
}

function includesAny(text, cues) {
  return cues.filter((cue) => cueMatches(text, cue));
}

function startsWithCue(text, cue) {
  const lower = normalize(text).trim();
  const escaped = String(cue).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(`^(?:(?:can|could)\\s+you\\s+|please\\s+|i\\s+need\\s+you\\s+to\\s+)?${escaped}(?:[^a-z0-9_]|$)`, 'i').test(lower);
}

function clearOperatorCues(text, cues) {
  return cues.filter((cue) => startsWithCue(text, cue));
}

function stripDestructiveCueWords(text = '') {
  return DESTRUCTIVE_BOUNDARY_CUES.reduce((out, cue) => {
    const escaped = String(cue).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    return out.replace(new RegExp(`(^|[^a-z0-9_])${escaped}([^a-z0-9_]|$)`, 'giu'), '$1 $2');
  }, String(text || ''));
}

function stripFencedPayloads(text) {
  return String(text || '').replace(/```[\s\S]*?```/gu, ' ');
}

function stripQuotedPayloadLines(text) {
  return String(text || '').split(/\r?\n/u).filter((line) => !/^\s*>/.test(line)).join('\n');
}

function operatorIntentText(message) {
  const withoutBlocks = stripQuotedPayloadLines(stripFencedPayloads(message));
  const colonMatch = withoutBlocks.match(/^([\s\S]{0,240}?\b(?:add|append|write|create|update)\b[\s\S]{0,160}?):[\s\S]*$/iu);
  if (colonMatch) return colonMatch[1].trim();
  return withoutBlocks.trim();
}

function routeReview({ action = 'plan', tool = null, targets = [], workspaceRoot = null, errors = [] } = {}) {
  const blockers = [...new Set((errors || []).filter(Boolean))];
  return {
    ok: blockers.length === 0,
    state: blockers.length ? 'invalid' : 'allowed',
    action: String(action || tool || 'plan').toLowerCase(),
    tool,
    targets: Array.isArray(targets) ? targets.filter(Boolean) : [],
    workspaceRoot: workspaceRoot || null,
    blockers,
    warnings: [],
    message: blockers.length ? 'invalid input' : 'allowed',
  };
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

export function inferActionObservability(message, workspaceContext = {}, action = null, _turnPlan = null) {
  const suppliedFiles = workspaceContext.files_mentioned || workspaceContext.files || [];
  const files = unique([...suppliedFiles]);
  const reviewTargets = unique([...suppliedFiles]);
  const workspaceRoot = workspaceContext.workspaceRoot || workspaceContext.workspace_root || null;
  const reviewMessage = operatorIntentText(message);
  const destructiveIntentCues = clearOperatorCues(reviewMessage, DESTRUCTIVE_BOUNDARY_CUES);
  const destructiveCues = destructiveIntentCues;
  const explicitAction = normalize(action);
  const explicitMutationAction = ['write', 'edit', 'patch', 'delete', 'create', 'mutate'].includes(explicitAction);
  const explicitWorkspaceAction = WORKSPACE_ACTIONS.includes(explicitAction);
  const localWorkCues = includesAny(reviewMessage, LOCAL_WORK_CUES);
  const needsWorkspace = files.length > 0 || explicitWorkspaceAction;
  const reviewText = destructiveIntentCues.length ? reviewMessage : stripDestructiveCueWords(reviewMessage);
  const review = routeReview({
    message: reviewText,
    action: explicitMutationAction ? explicitAction : (destructiveCues[0] || 'plan'),
    targets: reviewTargets,
    workspaceRoot,
  });
  return {
    needsWorkspace,
    editCues: [],
    localWorkCues,
    destructiveCues,
    review,
  };
}
