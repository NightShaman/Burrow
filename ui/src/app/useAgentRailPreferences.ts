import { useEffect, useState } from 'react';
import { readStoredValue, writeStoredValue, type StoredValueValidator } from './browserStorage';
import type { Agent } from './types';

export const agentRailPreferencesKey = 'hc.agentRailPreferences';
export type AgentRailView = 'regular' | 'compact';
export type AgentRailPreferences = { view: AgentRailView; order: string[] };

const isAgentRailPreferences: StoredValueValidator<AgentRailPreferences> = (value): value is AgentRailPreferences => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as AgentRailPreferences;
  return (candidate.view === 'regular' || candidate.view === 'compact')
    && Array.isArray(candidate.order)
    && candidate.order.every((id) => typeof id === 'string');
};

export function orderAgents(agents: Agent[], order: string[]) {
  const rank = new Map(order.map((id, index) => [id, index]));
  return agents
    .map((agent, sourceIndex) => ({ agent, sourceIndex }))
    .sort((left, right) => {
      const leftRank = rank.get(left.agent.id);
      const rightRank = rank.get(right.agent.id);
      if (leftRank === undefined && rightRank === undefined) return left.sourceIndex - right.sourceIndex;
      if (leftRank === undefined) return 1;
      if (rightRank === undefined) return -1;
      return leftRank - rightRank;
    })
    .map(({ agent }) => agent);
}

export function completeAgentOrder(agents: Agent[], order: string[]) {
  const known = new Set(agents.map((agent) => agent.id));
  return [...order.filter((id) => known.has(id)), ...agents.map((agent) => agent.id).filter((id) => !order.includes(id))];
}

export function useAgentRailPreferences() {
  const [preferences, setPreferences] = useState<AgentRailPreferences>(() => readStoredValue({
    key: agentRailPreferencesKey,
    version: 1,
    fallback: { view: 'regular', order: [] },
    validate: isAgentRailPreferences,
  }));
  useEffect(() => writeStoredValue(agentRailPreferencesKey, 1, preferences), [preferences]);
  return [preferences, setPreferences] as const;
}
