import type { Agent } from './types';

// Keep the full catalog for management and historical attribution. Only choices
// and operational agent lists use this projection; never filter stored records.
export function isAgentEnabled(agent: Pick<Agent, 'enabled' | 'activity'>): boolean {
  return agent.enabled ?? agent.activity !== 'Disabled';
}

export function enabledAgents<T extends Pick<Agent, 'enabled' | 'activity'>>(agents: T[]): T[] {
  return agents.filter(isAgentEnabled);
}

// Surface-specific projections leave the source catalog intact for Archive.
export function settingsAgents<T extends Pick<Agent, 'modAgent'>>(agents: T[]): T[] {
  return agents.filter((agent) => !agent.modAgent);
}
export function chatAgents<T extends Pick<Agent, 'enabled' | 'activity' | 'modAgent'>>(
  agents: T[],
): T[] {
  return enabledAgents(agents);
}
export function capabilityAgents<T extends Pick<Agent, 'enabled' | 'activity' | 'modAgent'>>(
  agents: T[],
  capability: 'brains' | 'forge',
): T[] {
  return enabledAgents(agents).filter(
    (agent) => !agent.modAgent || agent.modAgent.capabilities[capability] === true,
  );
}
