/** Maps known internal tool identifiers to operator-facing labels without changing stored evidence. */
export function toolDisplayName(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) return 'Tool activity';
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (normalized === 'spawn_subagent') return 'Spawn Minion';
  return value;
}
