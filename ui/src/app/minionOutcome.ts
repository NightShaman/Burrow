/** Only structured recorded outcomes are authoritative; counts and prose are not. */
export type MinionResult = { ok?: boolean; summary?: string; blockers?: number | string[]; blockerReasons?: string[]; outcome?: string | null };
export function minionOutcome(status?: string | null, result?: MinionResult | null) {
  const blockers = Array.isArray(result?.blockerReasons) ? result.blockerReasons : Array.isArray(result?.blockers) ? result.blockers : [];
  const incomplete = result?.outcome === 'incomplete' || status?.toLowerCase() === 'incomplete' || blockers.includes('subagent_incomplete');
  const failure = status?.toLowerCase() === 'timed_out' || blockers.some(blocker => /^subagent_(?:child_failed|spawn_failed|invalid_json|child_dispatch_failed|dispatch_failed|model_failed|failed|timed_out)(?::|$)/.test(blocker));
  const label = failure ? 'Error' : incomplete ? 'Incomplete' : undefined;
  const reason = [result?.summary, ...blockers].filter(Boolean).join(' · ') || undefined;
  return { label, reason };
}
