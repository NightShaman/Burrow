import { grantedMcpTool } from './mcp-menu.mjs';
import { evaluateExecutionBoundaries } from './execution-boundaries.mjs';

function validationReview({ action = 'plan', tool = null, targets = [], workspaceRoot = null, errors = [] } = {}) {
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

function addBoundaryBlockers({ blockers, review, boundaries, operation, command = '', paths = [], workspaceRoot = null } = {}) {
  const boundary = evaluateExecutionBoundaries({ boundaries, operation, command, paths, baseRoot: workspaceRoot });
  if (!boundary.ok) blockers.push(...boundary.blockers);
  if (review && typeof review === 'object') {
    review.boundary = boundary.matches.length ? { ok: boundary.ok, matches: boundary.matches } : null;
    review.blockers = [...new Set([...(review.blockers || []), ...boundary.blockers])];
    review.ok = review.blockers.length === 0;
    review.state = review.ok ? review.state : 'hard_policy_block';
    review.message = review.ok ? review.message : 'hard policy boundary';
  }
  return boundary;
}

function patchPaths(patch = '') {
  const paths = [];
  for (const line of String(patch || '').split(/\r?\n/)) {
    const diff = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (diff) { paths.push(diff[1], diff[2]); continue; }
    const marker = /^(?:---|\+\+\+)\s+(?:a\/|b\/)?(.+)$/.exec(line);
    if (marker && marker[1] !== '/dev/null') paths.push(marker[1].split('\t')[0]);
  }
  return [...new Set(paths.filter(Boolean))];
}

function reviewAction(action = {}, { workspaceRoot = null, executionContext = null } = {}) {
  const blockers = [];
  const warnings = [];
  const risk = [];
  const boundaries = executionContext?.executionBoundaries || null;

  if (action.errors?.length) blockers.push(...action.errors);

  if (['files_read', 'files_list', 'files_find', 'files_inspect', 'files_search', 'git_status', 'git_diff'].includes(action.tool)) {
    risk.push('read-only');
    const target = action.filePath || action.path || action.dirPath || null;
    const review = validationReview({
      message: action.intent || '',
      action: 'inspect',
      tool: action.tool,
      targets: target ? [target] : [],
      workspaceRoot,
      errors: action.errors
    });
    blockers.push(...review.blockers);
    return {
      index: action.index,
      tool: action.tool,
      status: blockers.length ? 'blocked' : 'allowed',
      risk,
      blockers: [...new Set(blockers)],
      warnings,
      review,
    };
  }

  if (action.tool === 'mcp_providers' || action.tool === 'mcp_capabilities') {
    risk.push('read-only');
    return { index: action.index, tool: action.tool, status: blockers.length ? 'blocked' : 'allowed', risk, blockers: [...new Set(blockers)], warnings };
  }

  if (action.tool === 'mcp_call') {
    const grant = grantedMcpTool({ connections: executionContext?.mcpConnections, grants: executionContext?.mcpTools, provider: action.mcpProvider, toolName: action.mcpToolName });
    risk.push('external-mcp');
    if (grant.error) blockers.push(grant.error);
    return { index: action.index, tool: action.tool, status: blockers.length ? 'blocked' : 'allowed', risk, blockers: [...new Set(blockers)], warnings };
  }

  if (action.tool === 'session_search' || action.tool === 'session_read_handoff' || action.tool === 'memory_working_search' || action.tool === 'memory_rolling_search' || action.tool === 'tasks_list') {
    risk.push('read-only');
    return {
      index: action.index,
      tool: action.tool,
      status: blockers.length ? 'blocked' : 'allowed',
      risk,
      blockers: [...new Set(blockers)],
      warnings,
    };
  }

  if (action.tool === 'memory_working_write' || action.tool === 'session_write_handoff' || action.tool === 'tasks_create' || action.tool === 'tasks_update' || action.tool === 'tasks_assign' || action.tool === 'tasks_delete' || action.tool === 'agent_update_tools_profile') {
    risk.push(action.tool === 'agent_update_tools_profile' ? 'agent-profile-write' : 'working-memory-write');
    return {
      index: action.index,
      tool: action.tool,
      status: blockers.length ? 'blocked' : 'allowed',
      verificationRequired: true,
      risk,
      blockers: [...new Set(blockers)],
      warnings,
    };
  }

  if (action.tool === 'files_edit') {
    risk.push('mutation');
    const review = validationReview({ message: action.intent || '', action: 'edit', tool: action.tool, targets: action.filePath ? [action.filePath] : [], workspaceRoot, errors: action.errors });
    blockers.push(...review.blockers);
    addBoundaryBlockers({ blockers, review, boundaries, operation: 'write', paths: action.filePath ? [action.filePath] : [], workspaceRoot });
    return { index: action.index, tool: action.tool, status: blockers.length ? 'blocked' : 'allowed', verificationRequired: true, risk, blockers: [...new Set(blockers)], warnings, review };
  }

  if (action.tool === 'files_write') {
    risk.push('mutation');
    const review = validationReview({
      message: action.intent || '',
      action: 'write',
      tool: action.tool,
      targets: action.filePath ? [action.filePath] : [],
      workspaceRoot,
      errors: action.errors
    });
    blockers.push(...review.blockers);
    addBoundaryBlockers({ blockers, review, boundaries, operation: 'write', paths: action.filePath ? [action.filePath] : [], workspaceRoot });
    warnings.push(...review.warnings);
    return {
      index: action.index,
      tool: action.tool,
      status: blockers.length ? 'blocked' : 'allowed',
      verificationRequired: true,
      risk,
      blockers: [...new Set(blockers)],
      warnings,
      review,
    };
  }

  if (action.tool === 'files_patch') {
    risk.push('mutation');
    const paths = patchPaths(action.patch);
    const review = validationReview({
      message: action.intent || '',
      action: 'patch',
      tool: action.tool,
      targets: paths,
      workspaceRoot,
      errors: action.errors
    });
    blockers.push(...review.blockers);
    addBoundaryBlockers({ blockers, review, boundaries, operation: 'write', paths, workspaceRoot });
    warnings.push(...review.warnings);
    return {
      index: action.index,
      tool: action.tool,
      status: blockers.length ? 'blocked' : 'allowed',
      verificationRequired: true,
      risk,
      blockers: [...new Set(blockers)],
      warnings,
      review,
    };
  }

  if (action.tool === 'agent_send_message') {
    risk.push('cross-agent-chat');
    return {
      index: action.index,
      tool: action.tool,
      status: blockers.length ? 'blocked' : 'allowed',
      risk,
      blockers: [...new Set(blockers)],
      warnings,
    };
  }

  if (action.tool === 'spawn_subagent') {
    risk.push('subagent');
    const targetRoot = action.target?.kind === 'filesystem' ? action.target.root : null;
    const review = validationReview({
      message: action.task || action.intent || '',
      action: 'spawn_subagent',
      tool: action.tool,
      targets: targetRoot ? [targetRoot] : [],
      workspaceRoot,
      errors: action.errors
    });
    blockers.push(...review.blockers);
    addBoundaryBlockers({ blockers, review, boundaries, operation: 'delegate', paths: targetRoot ? [targetRoot] : [], workspaceRoot });
    warnings.push(...review.warnings);
    return {
      index: action.index,
      tool: action.tool,
      status: blockers.length ? 'blocked' : 'allowed',
      risk,
      blockers: [...new Set(blockers)],
      warnings,
      review,
    };
  }

  if (action.tool === 'shell_exec') {
    const command = action.command || '';
    const review = validationReview({
      message: action.intent || '',
      action: 'shell_exec',
      tool: action.tool,
      command,
      targets: action.cwd ? [action.cwd] : [],
      workspaceRoot,
      errors: action.errors
    });
    blockers.push(...review.blockers);
    addBoundaryBlockers({ blockers, review, boundaries, operation: 'execute', command, paths: action.cwd ? [action.cwd] : [], workspaceRoot });
    warnings.push(...review.warnings);
    if (/^(npm\s+(run\s+)?(test|check|lint|build)|node\s+--test|node\s+--check|git\s+status\b|git\s+diff\b|grep\b|cat\b|ls\b|pwd\b|test\b)/i.test(command)) risk.push('safe-check');
    if (!risk.length) risk.push('unknown-shell_exec');

    const hardBlocked = blockers.length > 0;
    return {
      index: action.index,
      tool: action.tool,
      status: hardBlocked ? 'blocked' : 'allowed',
      risk: [...new Set(risk)],
      blockers: [...new Set(blockers)],
      warnings,
      review,
    };
  }

  return {
    index: action.index ?? null,
    tool: action.tool ?? null,
    status: blockers.length ? 'blocked' : 'blocked',
    risk: risk.length ? risk : ['unknown-tool'],
    blockers: blockers.length ? blockers : ['unsupported_tool'],
    warnings,
  };
}

export function reviewProposalActions({ actions = [], workspaceRoot = null, executionContext = null } = {}) {
  const reviews = actions.map((action) => reviewAction(action, { workspaceRoot, executionContext }));
  return {
    ok: reviews.every((review) => review.status === 'allowed'),
    reviews,
    counts: reviews.reduce((counts, review) => {
      counts[review.status] = (counts[review.status] || 0) + 1;
      return counts;
    }, {}),
  };
}

export const __test__ = { reviewAction, patchPaths };
