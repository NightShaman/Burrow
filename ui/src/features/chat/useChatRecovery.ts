import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api, type ActiveChatRunsResponse, type ProgressEntry } from '../../app/api';
import { isChatRunNotFoundError } from './useLiveSteering';
import { conversationCacheGeneration } from './chatConversationCache';
import { projectChatActivity, type RuntimeRunForSelection } from './chatActivityProjection';

type RunIdentity = Pick<RuntimeRunForSelection, 'agentId' | 'sessionId' | 'runId'>;
const runKey = (run: RunIdentity) => JSON.stringify([run.agentId, run.sessionId, run.runId]);
type Projection = ReturnType<typeof projectChatActivity>;
type RecoveryContext = { current: () => boolean; generation: number; recoveredProgress: Record<string, ProgressEntry[]> };
type Options = { agentId: string; sessionId: string; enabled: boolean; isChildSession: boolean; onRefresh: (context: RecoveryContext) => Promise<boolean>; onError: (message: string) => void };
const emptyActivity = { runtimeRun: null, childActivities: [], a2aActivities: [] };

/** Owns supplemental activity polling/cancellation, never a second transcript/cache. */
export function useChatRecovery({ agentId, sessionId, enabled, isChildSession, onRefresh, onError }: Options) {
  const [activity, setActivity] = useState<Pick<Projection, 'runtimeRun' | 'childActivities' | 'a2aActivities'>>(emptyActivity);
  const callbacks = useRef({ onRefresh, onError });
  useLayoutEffect(() => { callbacks.current = { onRefresh, onError }; });
  // Keep acknowledged stops retired even if an in-flight/stale poll repeats
  // them. Reconciliation remains pending until the runtime no longer reports
  // the retired identity and one final transcript refresh succeeds.
  const retiredRuns = useRef(new Set<string>());
  const retiredRefreshNeeded = useRef(new Set<string>());
  const terminalRefreshNeeded = useRef(new Set<string>());
  const retireRuntimeRun = useCallback((run: RunIdentity) => {
    const key = runKey(run);
    retiredRuns.current.add(key);
    retiredRefreshNeeded.current.add(key);
    setActivity((current) => current.runtimeRun && runKey(current.runtimeRun) === key ? { ...current, runtimeRun: null } : current);
  }, []);
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
    const terminalScopeKey = JSON.stringify([agentId, sessionId]);
    const poll = async () => {
      const generation = conversationCacheGeneration;
      try {
        const response = await api<ActiveChatRunsResponse>(`/api/chat/runs/active?agentId=${encodeURIComponent(agentId)}&sessionId=${encodeURIComponent(sessionId)}`, { signal: controller.signal });
        if (!current() || conversationCacheGeneration !== generation) return;
        const reportedRunKeys = new Set((response.runs ?? []).filter((run) => ['running', 'cancelling'].includes(String(run.status || '').toLowerCase())).map(runKey));
        const projection = projectChatActivity({ ...response,
          runs: (response.runs ?? []).filter((run) => !retiredRuns.current.has(runKey(run))),
          subagents: response.subagents?.filter((child) => !retiredRuns.current.has(runKey({ agentId: child.agentId || '', sessionId: child.sessionId || (typeof child.trace?.childSessionId === 'string' ? child.trace.childSessionId : ''), runId: child.runId || child.id }))),
        }, { agentId, sessionId, isChildSession, hadRuns, now: Date.now() });
        if (projection.runtimeRun) recoveredProgress.current[projection.runtimeRun.runId] = projection.runtimeRun.progress;
        setActivity(projection);
        if (hadRuns && !projection.hadRuns) terminalRefreshNeeded.current.add(terminalScopeKey);
        hadRuns = projection.hadRuns;
        // Child workers persist outside the active-run registry; also refresh
        // after the last active run disappears to pick up terminal writes.
        const settledRetired = [...retiredRefreshNeeded.current].filter((key) => {
          const [retiredAgentId, retiredSessionId] = JSON.parse(key) as [string, string, string];
          return retiredAgentId === agentId && retiredSessionId === sessionId && !reportedRunKeys.has(key);
        });
        if (projection.shouldRefresh || terminalRefreshNeeded.current.has(terminalScopeKey) || settledRetired.length) {
          const applied = await callbacks.current.onRefresh({ current, generation, recoveredProgress: recoveredProgress.current });
          if (current() && applied) {
            terminalRefreshNeeded.current.delete(terminalScopeKey);
            settledRetired.forEach((key) => retiredRefreshNeeded.current.delete(key));
          }
        }
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
    const owner = scope.current;
    const generation = conversationCacheGeneration;
    cancelController.current?.abort();
    const controller = new AbortController(); cancelController.current = controller;
    try {
      await api(`/api/chat/${encodeURIComponent(run.runId)}/cancel`, { signal: controller.signal, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentId: run.agentId, reason: 'Stopped by operator' }) });
    } catch (error) {
      if (controller.signal.aborted || scope.current !== owner) return;
      if (!isChatRunNotFoundError(error)) {
        callbacks.current.onError(error instanceof Error ? `Could not stop run: ${error.message}` : 'Could not stop run.');
        return;
      }
    }
    if (controller.signal.aborted || scope.current !== owner) return;
    retireRuntimeRun(run);
    const current = () => scope.current === owner && !controller.signal.aborted;
    try { await callbacks.current.onRefresh({ current, generation, recoveredProgress: recoveredProgress.current }); } catch { /* Final reconciliation waits for runtime disappearance and retries by poll. */ }
  }, [retireRuntimeRun]);
  return { a2aActivities: activity.a2aActivities, runtimeRun: activity.runtimeRun, runtimeChildActivities: activity.childActivities, clearActivity, cancelRuntimeRun, retireRuntimeRun };
}
