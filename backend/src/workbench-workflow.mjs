export function workbenchWorkflow({ session = {}, actionRoute = null, workspaceRoot = null } = {}) {
  const kind = actionRoute?.kind || session?.kind || 'answer';
  const escalationCommand = session?.workbench?.escalationCommand || session?.safeHands?.escalationCommand || null;
  const hasWorkspaceContext = Boolean(workspaceRoot || session?.workspaceRoot);
  const stepsByKind = {
    answer: [],
    plan: [
      { id: 'plan', label: 'Plan', command: 'burrow run --dry-run', required: true, status: 'available' },
    ],
    inspect: [
      { id: 'inspect', label: hasWorkspaceContext ? 'Inspect workspace' : 'Inspect local context', command: 'burrow run --dry-run', required: true, status: 'available' },
    ],
    mutate: [
      { id: 'inspect', label: 'Inspect current state', command: 'burrow run --dry-run', required: true, status: 'available' },
      { id: 'propose', label: 'Propose mutation', command: 'burrow run --call-model --execute-proposals --allow-mutation-proposals', required: true, status: 'available' },
      { id: 'verify', label: 'Verify mutation evidence', command: 'npm run check or configured verify command', required: true, status: 'separate' },
      { id: 'commit', label: 'Commit only after verification', command: 'burrow factory or --commit-changes', required: false, status: 'separate' },
    ],
    factory: [
      { id: 'inspect', label: 'Inspect dirty/protected branch state', command: 'git status + branch guard', required: true, status: 'available' },
      { id: 'factory', label: 'Run bounded factory transaction', command: 'burrow factory', required: true, status: 'available' },
      { id: 'verify', label: 'Require passing verification', command: 'configured check evidence', required: true, status: 'enforced' },
      { id: 'commit', label: 'Commit verified changes', command: 'git commit via factory', required: true, status: 'enforced' },
    ],
  };
  return {
    kind,
    needsWorkspace: false,
    workspaceContext: hasWorkspaceContext,
    blocked: false,
    blockers: [],
    escalationCommand,
    mayMutateInline: false,
    mayCommitInline: false,
    steps: stepsByKind[kind] || stepsByKind.answer,
  };
}
