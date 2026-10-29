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
  const bySessionAndRun = new Map<string, Map<string, MinionNode>>();
  for (const node of nodes.values()) {
    if (!node.minion.runId) continue;
    const sessionId = node.minion.resourceId ?? node.minion.id;
    const sessionRuns = bySessionAndRun.get(sessionId) ?? new Map<string, MinionNode>();
    sessionRuns.set(node.minion.runId, node);
    bySessionAndRun.set(sessionId, sessionRuns);
  }
  const parents = new Map<MinionNode, MinionNode>();
  for (const node of nodes.values()) {
    // Sessions and run ids can both be reused. When both parent ids are known,
    // require one retained parent to match both rather than falling back to either.
    const { parentRunId, parentSessionId } = node.minion;
    const parent = parentRunId
      ? parentSessionId
        ? bySessionAndRun.get(parentSessionId)?.get(parentRunId)
        : byRun.get(parentRunId)
      : bySession.get(parentSessionId ?? '');
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
