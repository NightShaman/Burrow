import { useRef } from 'react';
import { apiForTarget } from './api';
import { targetForResource, type ApiTarget } from './apiTargets';
import type { Agent, SavedProvider } from './types';

type Entry = { next: Agent; version: number; running: boolean };
/** Serialize full-selection writes per captured owner; merge rapid partial intents
 * before acknowledgements, and never render an acknowledgement for older intent. */
export function useModelSelectionWriter(targets: ApiTarget[], providers: SavedProvider[], commit: (id: string, patch: Partial<Agent>) => void, report: (message: string) => void) {
  const entries = useRef(new Map<string, Entry>());
  return async (selected: Agent, patch: Partial<Agent>) => {
    const owner = targetForResource(targets, selected.id);
    const key = JSON.stringify([owner.target.id, owner.target.baseUrl, owner.resourceId]);
    let entry = entries.current.get(key);
    const next = { ...(entry?.running ? entry.next : selected), ...patch };
    if (!providers.some(item => item.provider === next.provider && item.models.includes(next.model))) return;
    if (!entry) { entry = { next, version: 0, running: false }; entries.current.set(key, entry); }
    entry.next = next; entry.version++;
    if (entry.running) return;
    entry.running = true;
    try {
      for (;;) {
        const version = entry.version, intent = entry.next;
        const connection = providers.find(item => item.provider === intent.provider && item.models.includes(intent.model));
        if (!connection) return;
        try {
          const { selection } = await apiForTarget<{ selection: { model: string; reasoningEffort: string; temperature?: number } }>(owner.target, `/api/agents/${encodeURIComponent(owner.resourceId)}/model-selection`, {
            method: 'PUT', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ connectionId: connection.id, model: intent.model, reasoningEffort: intent.effort, temperature: intent.temperature }),
          });
          if (version === entry.version) commit(selected.id, { provider: connection.provider, model: selection.model, effort: selection.reasoningEffort, temperature: typeof selection.temperature === 'number' && Number.isFinite(selection.temperature) ? selection.temperature : intent.temperature });
        } catch (error) {
          if (version === entry.version) report(`Could not save model selection: ${(error as Error).message}`);
        }
        if (version === entry.version) break;
      }
    } finally { entry.running = false; entries.current.delete(key); }
  };
}
