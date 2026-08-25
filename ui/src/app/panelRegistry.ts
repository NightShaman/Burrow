import type { PanelId } from './types';

export type PanelDefinition = { id: PanelId; label: string; title?: string };

export const panelRegistry: readonly PanelDefinition[] = [
  { id: 'none', label: 'None' },
  { id: 'agents', label: 'Agents' },
  { id: 'workspace', label: 'Workspace' },
  { id: 'codex', label: 'Codex-LB', title: 'Account Status (Codex-LB)' },
  { id: 'accounts', label: 'Accounts', title: 'Account Status' },
  { id: 'system', label: 'System' },
];

export const panelIds = panelRegistry.map(({ id }) => id) as PanelId[];

export function getPanelTitle(id: PanelId) {
  const panel = panelRegistry.find((item) => item.id === id);
  return panel?.title ?? panel?.label ?? 'None';
}
