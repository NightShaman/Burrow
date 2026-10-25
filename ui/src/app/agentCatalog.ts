import type { Agent } from './types';

// Keep the full catalog for management and historical attribution. Only choices
// and operational agent lists use this projection; never filter stored records.
export function isAgentEnabled(agent: Pick<Agent, 'enabled' | 'activity'>): boolean {
  return agent.enabled ?? agent.activity !== 'Disabled';
}

export function enabledAgents<T extends Pick<Agent, 'enabled' | 'activity'>>(agents: T[]): T[] {
  return agents.filter(isAgentEnabled);
}
