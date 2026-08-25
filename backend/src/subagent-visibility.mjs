export function isVisibleSubagent(item, now = Date.now()) {
  if (!item.final) return true;
  const updatedAt = Date.parse(item.updatedAt || '');
  const recent = Number.isFinite(updatedAt) && now - updatedAt <= 60 * 60 * 1000;
  const result = item.result;
  return recent && Boolean(result?.summary || result?.ok !== undefined);
}

// Subagent records are the authority for child visibility. Agent-status is
// supplementary telemetry, so a delayed or already-finished child remains
// visible even when its status row has not arrived or has been pruned.
export function visibleSubagentChildren(items, ownerSessionId = 'default', now = Date.now()) {
  return (items || [])
    .filter((item) => item?.owner?.sessionId === ownerSessionId && item?.trace?.childSessionId && isVisibleSubagent(item, now))
    .sort((left, right) => Number(Boolean(left.final)) - Number(Boolean(right.final)))
    .slice(0, 8);
}

export function splitSubagentChildren(items) {
  const children = items || [];
  return {
    active: children.filter((item) => !item.final),
    completed: children.filter((item) => item.final),
  };
}
