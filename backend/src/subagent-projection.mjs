import { DEFAULT_MINION_DEPTH, MAX_MINION_DEPTH } from './minion-depth.mjs';

const finalStatuses = new Set(['succeeded', 'failed', 'cancelled', 'timed_out']);
const text = value => typeof value === 'string' && value.trim() ? value.trim() : null;
const maxDepthOr = (value, fallback = DEFAULT_MINION_DEPTH) => Number.isInteger(value) && value >= 0 && value <= MAX_MINION_DEPTH ? value : fallback;

// The caller reads one agent's durable data root. Also reject explicit foreign
// identities if a malformed/imported record carries one; session ids alone are
// never sufficient to join records across agents.
export function projectSubagentTree(records = [], { agentId = null, sessionId = null, rootSessionId = null, activeSessions = [], visible = () => true } = {}) {
  const owns = record => record && (!agentId || [record.agentId, record.owner?.agentId].every(id => !id || id === agentId));
  const merged = records.filter(owns);
  const knownSessions = new Set(merged.map(record => text(record.trace?.childSessionId) || text(record.sessionId)).filter(Boolean));
  // Merge before selecting scope: a live grandchild's durable record (and even
  // its parent's record) may have been retained away. Only explicit child
  // metadata supplies a node; ordinary active chats are not fictitious minions.
  for (const run of activeSessions) {
    if (!owns(run) || !owns(run.metadata || {})) continue;
    const id = text(run.sessionId);
    if (!id || knownSessions.has(id)) continue;
    const ancestry = sessionMinionAncestry({ sessionId: id, runId: run.runId, metadata: run.metadata });
    if (ancestry.depth === 0) continue;
    merged.push({
      ...ancestry,
      agentId: agentId || run.agentId,
      id: ancestry.subagentId,
      owner: { sessionId: ancestry.parentSessionId, parentRunId: ancestry.parentRunId },
      trace: { childSessionId: id, runId: ancestry.runId },
      label: text(run.metadata?.label),
      status: run.status || 'running',
      phase: run.phase || 'thinking',
      createdAt: run.startedAt || null,
      updatedAt: run.startedAt || null,
      final: false,
    });
    knownSessions.add(id);
  }
  const nodes = merged.map(record => {
    const marker = record.minionDepth || record;
    return {
      ...record,
      ...(agentId ? { agentId } : {}),
      sessionId: text(record.trace?.childSessionId) || text(record.sessionId),
      parentSessionId: text(record.owner?.sessionId) || text(record.parentSessionId),
      parentRunId: text(record.owner?.parentRunId) || text(record.owner?.turnId) || text(record.parentRunId),
      runId: text(record.trace?.runId) || text(record.runId) || text(record.id),
      subagentId: text(record.id) || text(record.subagentId),
      depth: Number.isInteger(marker.depth) && marker.depth > 0 ? marker.depth : 1,
      maxDepth: maxDepthOr(marker.maxDepth),
      rootSessionId: text(marker.rootSessionId),
      rootRunId: text(marker.rootRunId),
      final: record.final === true || finalStatuses.has(record.status),
    };
  });
  const bySession = new Map();
  for (const node of nodes) {
    if (!node.sessionId) continue;
    if (!bySession.has(node.sessionId)) bySession.set(node.sessionId, []);
    bySession.get(node.sessionId).push(node);
  }
  const parentOf = node => {
    const candidates = (bySession.get(node.parentSessionId) || []).filter(parent =>
      !(node.rootSessionId && parent.rootSessionId && node.rootSessionId !== parent.rootSessionId)
      && !(node.rootRunId && parent.rootRunId && node.rootRunId !== parent.rootRunId));
    // A known run mismatch is not an ancestry edge. Historical records without
    // a trace run id can still be joined by their immediate session identity.
    return (node.parentRunId && candidates.find(parent => parent.runId === node.parentRunId))
      || candidates.find(parent => !node.parentRunId || !parent.trace?.runId) || null;
  };
  const explicitRoots = new Map(nodes.map(node => [node, node.rootSessionId]));
  for (const node of nodes) {
    let current = node;
    const visited = new Set();
    while (current && !visited.has(current)) {
      visited.add(current);
      if (!node.rootSessionId && current.rootSessionId) node.rootSessionId = current.rootSessionId;
      if (!node.rootRunId && current.rootRunId) node.rootRunId = current.rootRunId;
      const parent = parentOf(current);
      if (!parent) {
        // An orphan's immediate parent is not necessarily its root. Only a
        // retained depth-one ancestor can establish an otherwise absent root.
        if (current.depth === 1) {
          if (!node.rootSessionId) node.rootSessionId = current.parentSessionId;
          if (!node.rootRunId) node.rootRunId = current.parentRunId;
        }
        break;
      }
      current = parent;
    }
  }
  const anchor = (bySession.get(sessionId) || [])[0];
  const expectedRoot = rootSessionId || anchor?.rootSessionId || sessionId;
  const inScope = node => {
    if (!sessionId) return true;
    const explicitRoot = explicitRoots.get(node);
    if (explicitRoot && expectedRoot && explicitRoot !== expectedRoot) return false;
    if (node.sessionId === sessionId || explicitRoot === sessionId) return true;
    let current = node;
    const visited = new Set();
    while (current && !visited.has(current)) {
      visited.add(current);
      if (current.parentSessionId === sessionId) return true;
      const parent = parentOf(current);
      if (parent && explicitRoots.get(parent) && expectedRoot && explicitRoots.get(parent) !== expectedRoot) return false;
      current = parent;
    }
    return false;
  };
  const scoped = new Set(nodes.filter(inScope));
  const selected = new Set();
  for (const node of scoped) {
    if (!visible(node) && node.sessionId !== sessionId) continue;
    let current = node;
    const visited = new Set();
    while (current && scoped.has(current) && !visited.has(current)) {
      visited.add(current);
      selected.add(current);
      current = parentOf(current);
    }
  }
  // Iterative ancestor-first traversal both preserves stable sibling order and
  // terminates for corrupt cycles. No ancestry is invented for orphan records:
  // their saved immediate parent and root marker remain distinct.
  const ordered = [];
  const emitted = new Set();
  for (const node of [...selected].sort((a, b) => a.depth - b.depth)) {
    let current = node;
    const chain = [];
    const visited = new Set();
    while (current && selected.has(current) && !emitted.has(current) && !visited.has(current)) {
      visited.add(current);
      chain.push(current);
      current = parentOf(current);
    }
    for (const ancestor of chain.reverse()) {
      if (emitted.has(ancestor)) continue;
      emitted.add(ancestor);
      ordered.push(ancestor);
    }
  }
  return ordered;
}

// Live runs may have no durable subagent record yet (or a historical record may
// have been retained away). Session metadata keeps such a child from becoming
// a fictitious depth-zero root when it is observed or reopened.
export function sessionMinionAncestry({ sessionId, runId = null, metadata = {}, maxDepth = DEFAULT_MINION_DEPTH, subagent = null } = {}) {
  // Child maxDepth is saved lineage, not recalculated spawn permission. Only a
  // depth-zero root reports the current setting supplied by the caller.
  if (subagent) {
    const { parentSessionId, parentRunId, subagentId, depth, maxDepth: savedMaxDepth, rootSessionId, rootRunId } = subagent;
    return { sessionId, runId: runId || subagent.runId, parentSessionId, parentRunId, subagentId, depth, maxDepth: savedMaxDepth, rootSessionId, rootRunId };
  }
  const marker = metadata?.minionDepth || {};
  const child = metadata?.sessionKind === 'subagent' || metadata?.parentChild === true || marker.depth > 0;
  return {
    sessionId,
    runId,
    parentSessionId: child ? text(metadata?.parentSessionId) : null,
    parentRunId: child ? text(metadata?.parentRunId) : null,
    subagentId: child ? text(metadata?.subagentId) : null,
    depth: child ? (Number.isInteger(marker.depth) && marker.depth > 0 ? marker.depth : 1) : 0,
    maxDepth: child ? maxDepthOr(marker.maxDepth) : maxDepthOr(maxDepth),
    rootSessionId: text(marker.rootSessionId) || (child ? (!marker.depth || marker.depth === 1 ? text(metadata?.parentSessionId) : null) : sessionId),
    rootRunId: text(marker.rootRunId) || (child ? (!marker.depth || marker.depth === 1 ? text(metadata?.parentRunId) : null) : runId),
  };
}
