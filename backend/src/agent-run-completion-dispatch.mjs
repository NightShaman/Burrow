// Advisory only: the durable feed is the source of truth. An HTTP run is
// released after the response finishes AND its activity owner is gone.
import { activeChatRunKey } from './active-chat-runs.mjs';

export function createAgentRunCompletionDispatch({ feed, activeRuns, getHosts }) {
  const pending = new Map();
  const http = new Map();
  const key = (agentId, runId) => JSON.stringify([agentId, runId]);
  function drain() {
    for (const [cursor, event] of pending) {
      const id = key(event.agentId, event.runId);
      if (activeRuns.has(activeChatRunKey(event.agentId, event.runId)) || http.has(id)) continue;
      pending.delete(cursor);
      for (const host of getHosts()) {
        if (!host?.hasRunCompletionHandler || !host.isAvailable()) continue;
        void host.invoke('agent-run-completion', { cursor }).catch(() => {});
      }
    }
  }
  const unsubscribe = feed.subscribe(event => { pending.set(event.cursor, event); drain(); });
  return {
    // Expose only transport readiness metadata to generic activity readers.
    // The model run can retire before the HTTP answer has finished sending.
    pendingHttpRuns: () => [...http.values()],
    trackHttp(agentId, runId, res, { sessionId = null, source = 'operator-chat', startedAt = null } = {}) {
      const id = key(agentId, runId);
      http.set(id, { agentId, sessionId, runId, source, startedAt, status: 'response_pending' });
      res.once('finish', () => { http.delete(id); drain(); });
      res.once('close', () => {
        if (res.writableFinished) return;
        http.delete(id);
        for (const [cursor, event] of pending) if (key(event.agentId,event.runId) === id) pending.delete(cursor);
      });
    },
    activityChanged: drain,
    close: unsubscribe,
  };
}
