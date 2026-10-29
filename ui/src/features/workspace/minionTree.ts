import type { Subagent } from '../../app/types';

export type MinionNode = { minion: Subagent; children: MinionNode[] };

/** Presentation only: the registry and stream lookup remain flat. */
export function minionTree(minions: Subagent[]): MinionNode[] {
  const nodes = new Map<string, MinionNode>();
  for (const minion of minions) {
    if (!nodes.has(minion.id)) nodes.set(minion.id, { minion, children: [] });
  }
  const bySession = new Map([...nodes.values()].map(node => [node.minion.resourceId ?? node.minion.id, node]));
  const byRun = new Map([...nodes.values()].filter(node => node.minion.runId).map(node => [node.minion.runId, node]));
  const parents = new Map<MinionNode, MinionNode>();
  for (const node of nodes.values()) {
    // Sessions can be reused across runs. A known parent run is authoritative;
    // if it is no longer retained, do not attach to a different run of its session.
    const parent = node.minion.parentRunId
      ? byRun.get(node.minion.parentRunId)
      : bySession.get(node.minion.parentSessionId ?? '');
    if (parent) parents.set(node, parent);
  }
  const roots: MinionNode[] = [];
  for (const node of nodes.values()) {
    // Missing/retained-away parents and malformed cycles must not hide work or
    // fabricate ancestry. Render those nodes at the top of the visible subtree.
    const seen = new Set([node]);
    let ancestor = parents.get(node);
    while (ancestor && !seen.has(ancestor)) {
      seen.add(ancestor);
      ancestor = parents.get(ancestor);
    }
    const parent = parents.get(node);
    if (ancestor || !parent) roots.push(node);
    else parent.children.push(node);
  }
  return roots;
}
