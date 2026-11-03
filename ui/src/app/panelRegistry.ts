import type { Agent, PanelId } from './types';

export type PanelDefinition = { id: PanelId; label: string; title?: string };

export const panelRegistry: readonly PanelDefinition[] = [
  { id: 'none', label: 'None' },
  { id: 'agents', label: 'Agents' },
  { id: 'workspace', label: 'Workspace' },
  { id: 'accounts', label: 'Accounts', title: 'Account Status' },
  { id: 'system', label: 'System' },
];

export const ownerPanelId = (modId: string): PanelId => `owner-agents:${modId}`;
export const ownerPanelModId = (id: PanelId): string | null =>
  id.startsWith('owner-agents:') && id.length > 'owner-agents:'.length
    ? id.slice('owner-agents:'.length)
    : null;

export function panelsForOwners(
  owners: readonly { modId: string; name: string }[],
): PanelDefinition[] {
  return [
    ...panelRegistry,
    ...owners.map(({ modId, name }) => ({ id: ownerPanelId(modId), label: name })),
  ];
}

export const panelIds = panelRegistry.map(({ id }) => id) as PanelId[];

export function getPanelTitle(id: PanelId, panels: readonly PanelDefinition[] = panelRegistry) {
  const panel = panels.find((item) => item.id === id);
  return panel?.title ?? panel?.label ?? 'None';
}

// Panel availability follows enabled ownership, not the current grouping toggle.
export function ownerPanelsForAgents(
  agents: Pick<Agent, 'modAgent'>[],
  owners: readonly { modId: string; name: string }[],
): PanelDefinition[] {
  const ids = [
    ...new Set(agents.flatMap((agent) => (agent.modAgent ? [agent.modAgent.ownerModId] : []))),
  ];
  return panelsForOwners(
    ids.map((modId) => ({
      modId,
      name: owners.find((owner) => owner.modId === modId)?.name ?? modId,
    })),
  );
}
