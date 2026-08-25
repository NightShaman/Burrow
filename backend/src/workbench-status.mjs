function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function unique(values) {
  return [...new Set(asArray(values).filter(Boolean))];
}

function auditMessage(value) {
  if (value.includes('sudo_used')) return 'sudo used';
  if (value.includes('external_effect')) return 'external effect';
  if (value.includes('destructive_pattern')) return 'destructive command pattern';
  if (value.includes('secret_like_target')) return 'secret-like target';
  if (value.includes('config_or_service_file')) return 'config or service file';
  if (value.includes('commit_requested')) return 'commit requested';
  if (value.includes('push_requested')) return 'push requested';
  if (value.includes('delete_requested')) return 'delete requested';
  if (value.includes('model_requested_boundary')) return 'model requested boundary';
  return value.replace(/^audit:/, '').replaceAll('_', ' ');
}

export function describeAuditLabel(code) {
  const value = String(code || '');
  if (!value) return null;
  if (!value.startsWith('audit:')) return { code: value, kind: 'warning', message: value, blocks: false };
  return { code: value, kind: value.split(':')[1] || 'audit', message: auditMessage(value), blocks: false };
}

export function describeBoundary(code) {
  const value = String(code || '');
  if (!value) return null;
  if (value.includes('blast_radius:clear_in_scope')) {
    return { code: value, kind: 'clear_in_scope', message: 'clear in-scope local action', ask: false };
  }
  if (value.includes('git_context_required')) {
    return { code: value, kind: 'missing_git_context', message: 'git repository context required', blocks: false };
  }
  if (value.includes('workspace_root_required')) {
    return { code: value, kind: 'missing_workspace_context', message: 'missing explicit context', blocks: false };
  }
  if (value.includes('blast_radius:unclear_scope')) {
    return { code: value, kind: 'unclear_scope', message: value.includes('old') ? 'which files count as old?' : 'target scope unclear', blocks: false };
  }
  if (value.includes('blast_radius:external_effect') || value.includes('external_communication') || value.includes('external_command')) {
    return { code: value, kind: 'external_effect_label', message: 'external-effect label', blocks: false };
  }
  if (value.includes('blast_radius:secrets_risk') || value.includes('secret')) {
    return { code: value, kind: 'secret_risk_label', message: 'secret-risk label', blocks: false };
  }
  if (value.includes('blast_radius:expands_blast_radius') || value.startsWith('outside_workspace')) {
    return { code: value, kind: 'outside_context_label', message: 'outside-context label', blocks: false };
  }
  if (value.includes('user_configured_hard_block')) {
    return { code: value, kind: 'hard_policy_block', message: 'user-configured hard block', blocks: true };
  }
  if (value.includes('blast_radius:hard_policy_block')) {
    return { code: value, kind: 'hard_policy_block', message: 'hard policy boundary', blocks: true };
  }
  if (value.includes('destructive')) {
    return { code: value, kind: 'destructive_label', message: 'destructive label', blocks: false };
  }
  return { code: value, kind: 'blocked', message: value, blocks: true };
}

export function translateBlockers(blockers = []) {
  return unique(blockers).map(describeBoundary).filter(Boolean);
}

export function translateWarnings(warnings = []) {
  return unique(warnings).map(describeAuditLabel).filter(Boolean);
}

function workbenchSteps(workflow = {}) {
  workflow = workflow || {};
  const labels = {
    inspect: 'Inspect',
    propose: 'Prepare',
    verify: 'Verify',
    commit: 'Commit',
    factory: 'Prepare commit',
  };
  return asArray(workflow.steps).map((step) => ({
    id: step.id,
    label: labels[step.id] || step.label || step.id,
    status: step.status || null,
    required: Boolean(step.required),
  }));
}

export function buildWorkbenchStatus({
  decision = null,
  session = null,
  actionRoute = null,
  workflow = null,
  backgroundWork = null,
  blockers = [],
  warnings = [],
  memory = null,
  runId = null,
  traceDir = null,
} = {}) {
  const rawBlockers = unique([
    ...asArray(blockers),
    ...asArray(backgroundWork?.blockers),
  ]);
  const rawWarnings = unique([
    ...asArray(warnings),
    ...asArray(actionRoute?.review?.warnings),
  ]);
  const boundaries = translateBlockers(rawBlockers);
  const kind = session?.kind || actionRoute?.kind || actionRoute?.route || 'answer';
  const workspaceRoot = backgroundWork?.workspaceRoot || session?.workspaceRoot || null;
  return {
    kind,
    state: backgroundWork?.status || decision || 'unknown',
    result: decision || null,
    blastRadius: {
      workspaceRoot,
      local: true,
      clear: kind === 'answer' || Boolean(workspaceRoot) || boundaries.length === 0,
      boundaries,
    },
    steps: workbenchSteps(workflow),
    blockers: boundaries,
    backgroundWork,
    warnings: rawWarnings,
    audit: translateWarnings(rawWarnings),
    memory: memory ? {
      ok: memory.ok ?? null,
      facts: memory.facts ?? 0,
      events: memory.events ?? 0,
      handoffs: memory.handoffs ?? 0,
      warnings: asArray(memory.warnings),
    } : { ok: null, facts: 0, events: 0, handoffs: 0, warnings: [] },
    trace: runId ? { runId, available: Boolean(traceDir) } : null,
  };
}

function chatSupportFromWorkbenchStatus(status = {}) {
  return {
    kind: status.kind,
    state: status.state,
    result: status.result,
    scope: status.blastRadius,
    steps: status.steps,
    blockers: status.blockers,
    backgroundWork: status.backgroundWork,
    warnings: status.warnings,
    audit: status.audit,
    memory: status.memory,
    trace: status.trace,
  };
}

export function buildChatSupportStatus(args = {}) {
  return chatSupportFromWorkbenchStatus(buildWorkbenchStatus(args));
}

export function chatSupportStatus(status = {}) {
  return chatSupportFromWorkbenchStatus(status);
}
