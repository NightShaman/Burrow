import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api, type ActiveChatRunsResponse, type ProgressEntry } from '../../app/api';
import { conversationCacheGeneration } from './chatConversationCache';
import { projectChatActivity, type RuntimeRunForSelection } from './chatActivityProjection';

type Projection = ReturnType<typeof projectChatActivity>;
type RecoveryContext = { current: () => boolean; generation: number; recoveredProgress: Record<string, ProgressEntry[]> };
type Options = { agentId: string; sessionId: string; enabled: boolean; isChildSession: boolean; onRefresh: (context: RecoveryContext) => Promise<void>; onError: (message: string) => void };
const emptyActivity = { runtimeRun: null, childActivities: [], a2aActivities: [] };

/** Owns supplemental activity polling/cancellation, never a second transcript/cache. */
export function useChatRecovery({ agentId, sessionId, enabled, isChildSession, onRefresh, onError }: Options) {
  const [activity, setActivity] = useState<Pick<Projection, 'runtimeRun' | 'childActivities' | 'a2aActivities'>>(emptyActivity);
  const callbacks = useRef({ onRefresh, onError });
  useLayoutEffect(() => { callbacks.current = { onRefresh, onError }; });
  const recoveredProgress = useRef<Record<string, ProgressEntry[]>>({});
  const scopeKey = JSON.stringify([agentId, sessionId, enabled, isChildSession]);
  const scope = useRef({ key: scopeKey });
  if (scope.current.key !== scopeKey) scope.current = { key: scopeKey };
  const clearActivity = useCallback(() => { setActivity(emptyActivity); }, []);
  useLayoutEffect(clearActivity, [clearActivity, scopeKey]);

  useEffect(() => {
    if (!enabled || !agentId || !sessionId) return;
    const owner = scope.current;
    const controller = new AbortController();
    const current = () => scope.current === owner && !controller.signal.aborted;
    let timer: number | undefined;
    let hadRuns = false;
    const poll = async () => {
      const generation = conversationCacheGeneration;
      try {
        const response = await api<ActiveChatRunsResponse>(`/api/chat/runs/active?agentId=${encodeURIComponent(agentId)}&sessionId=${encodeURIComponent(sessionId)}`, { signal: controller.signal });
        if (!current() || conversationCacheGeneration !== generation) return;
        const projection = projectChatActivity(response, { agentId, sessionId, isChildSession, hadRuns, now: Date.now() });
        if (projection.runtimeRun) recoveredProgress.current[projection.runtimeRun.runId] = projection.runtimeRun.progress;
        setActivity(projection);
        hadRuns = projection.hadRuns;
        // Child workers persist outside the active-run registry; also refresh
        // after the last active run disappears to pick up terminal writes.
        if (projection.shouldRefresh) await callbacks.current.onRefresh({ current, generation, recoveredProgress: recoveredProgress.current });
      } catch {
        // Supplemental activity failure must not replace durable chat/error state.
      } finally {
        if (current()) timer = window.setTimeout(poll, 1000);
      }
    };
    void poll();
    return () => { controller.abort(); if (timer !== undefined) window.clearTimeout(timer); };
  }, [agentId, sessionId, enabled, isChildSession]);

  const cancelController = useRef<AbortController | null>(null);
  useEffect(() => () => { cancelController.current?.abort(); }, [scopeKey]);
  const cancelRuntimeRun = useCallback(async (run: RuntimeRunForSelection) => {
    cancelController.current?.abort();
    const controller = new AbortController(); cancelController.current = controller;
    try {
      await api(`/api/chat/${encodeURIComponent(run.runId)}/cancel`, { signal: controller.signal, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentId: run.agentId, reason: 'Stopped by operator' }) });
    } catch (error) {
      if (controller.signal.aborted) return;
      callbacks.current.onError(error instanceof Error ? `Could not stop run: ${error.message}` : 'Could not stop run.');
    }
  }, []);
  return { a2aActivities: activity.a2aActivities, runtimeRun: activity.runtimeRun, runtimeChildActivities: activity.childActivities, clearActivity, cancelRuntimeRun };
}
