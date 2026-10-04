import type { Agent } from './types';
import type { ApiTarget } from './apiTargets';

/** UI identities are never resource identities. Resolve against the captured owner. */
export function ownedAgentResource(agents: Agent[], id: string, target: ApiTarget | null | undefined): string {
  const agent = agents.find((item) => item.id === id);
  if (!target?.enabled || !agent || (agent.targetId ?? 'local') !== target.id) throw new Error('Agent does not belong to this runtime');
  const resource = agent.resourceId ?? (target.id === 'local' && !id.includes('::') ? id : '');
  if (!resource || resource.includes('::')) throw new Error('Agent resource identity unavailable');
  return resource;
}
