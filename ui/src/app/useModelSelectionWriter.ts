import { chatProvider, isNativeThinkingProvider } from './modelSelectionOptions';
import { useRef } from 'react';
import { api } from './api';
import type { Agent, SavedProvider } from './types';

type Entry = { next: Agent; version: number; waiters: ((accepted: boolean) => void)[] };
// Overview requests may have started before a successful save. Track only
// acknowledged writes; failed/pending intents must not mask server snapshots.
const acknowledgedVersions = new Map<string, number>();
export const modelSelectionWriteVersion = (agentId: string) =>
  acknowledgedVersions.get(agentId) ?? 0;
/** Serialize writes per captured owner and settle callers only after the latest
 * merged intent is acknowledged. Older acknowledgements never replace it. */
export function useModelSelectionWriter(
  providers: SavedProvider[],
  commit: (id: string, patch: Partial<Agent>) => void,
  report: (message: string) => void,
  pendingChanged?: (id: string, pending: boolean) => void,
) {
  const entries = useRef(new Map<string, Entry>());
  return (selected: Agent, patch: Partial<Agent>): Promise<boolean> => {
    const resourceId = selected.resourceId ?? selected.id;
    const key = JSON.stringify(['local', resourceId]);
    const pending = entries.current.get(key);
    const next = { ...(pending?.next ?? selected), ...patch };
    // A deliberate provider change replaces the old connection identity.
    if (
      patch.provider !== undefined &&
      patch.provider !== (pending?.next ?? selected).provider &&
      patch.modelConnectionId === undefined
    )
      next.modelConnectionId = providers.find((item) => item.provider === patch.provider)?.id;
    const connection = chatProvider(next, providers);
    if (!connection || !connection.models.includes(next.model)) {
      report('Could not save model selection: the selected connection or model is unavailable.');
      return Promise.resolve(false);
    }
    const entry: Entry = pending ?? { next, version: 0, waiters: [] };
    entry.next = next;
    entry.version++;
    const completion = new Promise<boolean>((resolve) => entry.waiters.push(resolve));
    if (pending) return completion;
    entries.current.set(key, entry);
    pendingChanged?.(selected.id, true);
    void (async () => {
      let accepted = false;
      try {
        for (;;) {
          const version = entry.version,
            intent = entry.next;
          const connection = chatProvider(intent, providers);
          if (!connection) break;
          try {
            const { selection } = await api<{
              selection: {
                model: string;
                reasoningEffort: string;
                thinkingMode?: string | null;
                temperature?: number;
              };
            }>(`/api/agents/${encodeURIComponent(resourceId)}/model-selection`, {
              method: 'PUT',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                connectionId: connection.id,
                model: intent.model,
                reasoningEffort: intent.effort,
                ...(isNativeThinkingProvider(connection)
                  ? { thinkingMode: intent.thinkingMode ?? null }
                  : {}),
                temperature: intent.temperature,
              }),
            });
            if (
              isNativeThinkingProvider(connection) &&
              (selection.model !== intent.model ||
                selection.reasoningEffort !== intent.effort ||
                (selection.thinkingMode ?? null) !== (intent.thinkingMode ?? null))
            ) {
              throw new Error('Invalid native model selection acknowledgement.');
            }
            if (version === entry.version) {
              acknowledgedVersions.set(selected.id, modelSelectionWriteVersion(selected.id) + 1);
              commit(selected.id, {
                provider: connection.provider,
                modelConnectionId: connection.id,
                model: selection.model,
                effort: selection.reasoningEffort,
                thinkingMode: selection.thinkingMode ?? null,
                temperature:
                  typeof selection.temperature === 'number' &&
                  Number.isFinite(selection.temperature)
                    ? selection.temperature
                    : intent.temperature,
              });
              accepted = true;
            }
          } catch (error) {
            if (version === entry.version)
              report(`Could not save model selection: ${(error as Error).message}`);
          }
          if (version === entry.version) break;
        }
      } finally {
        entries.current.delete(key);
        pendingChanged?.(selected.id, false);
        entry.waiters.forEach((resolve) => resolve(accepted));
      }
    })();
    return completion;
  };
}
