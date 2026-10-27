import { chatToolIdentity } from './chatToolIdentity';
import { useEffect, useRef, useState } from 'react';
import { answerFromChatResult, api, createRunId, type ChatAttachment, type ProgressEntry, type RunProgress, type SessionTurn, type ToolActivityItem } from '../../app/api';
import type { Agent, SavedProvider } from '../../app/types';
import { streamChat } from './chatStream';
import { isChatRunNotFoundError } from './useLiveSteering';
import { appendThoughtDelta, finalizeThoughtProgress } from './chatThoughtProgress';

import { projectLiveStage, type LiveStageProjection, type ChatLiveStage } from './chatLiveStage';

type ActiveRun = { runId: string; agentId: string; sessionId: string; stage?: ChatLiveStage; projection?: LiveStageProjection };
type StreamToolEvent = { tool?: unknown; rawTool?: unknown; activityId?: unknown; ok?: unknown; status?: unknown; label?: unknown; detail?: unknown; provider?: unknown; mcpToolName?: unknown; skillId?: unknown; skillName?: unknown; version?: unknown; command?: unknown; cwd?: unknown; filePath?: unknown; dirPath?: unknown; query?: unknown; reason?: unknown; result?: unknown; output?: unknown; error?: unknown };

type ChatRunSession = {
  attached: ChatAttachment[];
  clearAttachment: () => void;
  sessionId: string;
  draft: string;
  setDraft: (value: string) => void;
  clearError: () => void;
  reportError: (message: string) => void;
  leaveNewSessionForMessage: () => void;
  appendTurn: (agentId: string, sessionId: string, turn: SessionTurn) => void;
  appendTransientTurn: (agentId: string, sessionId: string, turn: SessionTurn) => void;
  storeToolActivity: (activity: { runId: string; items: ToolActivityItem[]; status: 'running' | 'ok' | 'warn' }) => void;
  toolActivityForRun: (runId: string) => { items?: ToolActivityItem[] } | undefined;
  clearRunState: (agentId: string, sessionId: string, runId: string) => void;
  refreshSessions: (agentId?: string) => Promise<void>;
  refreshConversation: (agentId?: string, sessionId?: string) => Promise<void>;
};

type UseChatRunOptions = {
  selectedAgentId: string;
  selected: Agent | undefined;
  savedProviders: SavedProvider[];
  session: ChatRunSession;
  setAgentActivity: (agentId: string, status: string) => void;
  onRunStopped?: (run: { agentId: string; sessionId: string; runId: string }) => void;
};

const runKey = (agentId: string, sessionId: string) => `${agentId}:${sessionId}`;
const minimumStreamOverlap = 16;

/**
 * Preserve only stream text that does not reappear at the beginning of the
 * terminal answer. Whitespace is normalized for the comparison so harmless
 * stream chunking differences do not leave a duplicated tail behind.
 */
export function trimStreamedAnswer(streamedAnswer: string, finalAnswer: string) {
  const stream = streamedAnswer.trim().replace(/\s+/g, ' ');
  const final = finalAnswer.trim().replace(/\s+/g, ' ');
  const maxOverlap = Math.min(stream.length, final.length);
  for (let length = maxOverlap; length >= minimumStreamOverlap; length -= 1) {
    if (stream.slice(-length) === final.slice(0, length)) return stream.slice(0, -length).trim();
  }
  return streamedAnswer.trim();
}

/** Owns one-to-one chat run state, stream lifecycle, and cancellation. */
export function useChatRun({ selectedAgentId, selected, savedProviders, session, setAgentActivity, onRunStopped }: UseChatRunOptions) {
  const [activeRuns, setActiveRuns] = useState<Record<string, ActiveRun>>({});
  const [liveProgressByRun, setLiveProgressByRun] = useState<Record<string, ProgressEntry[]>>({});
  const [liveAnswerByRun, setLiveAnswerByRun] = useState<Record<string, string>>({});
  const streamAbortRef = useRef<Record<string, AbortController>>({});
  const activeRunForSelection = selectedAgentId && session.sessionId ? activeRuns[runKey(selectedAgentId, session.sessionId)] ?? null : null;

  useEffect(() => {
    const runId = activeRunForSelection?.runId;
    if (!runId || !(liveAnswerByRun[runKey(selectedAgentId, session.sessionId)] || liveProgressByRun[runKey(selectedAgentId, session.sessionId)]?.some((item) => item.text))) return;
    if (!performance.getEntriesByName(`chat:${runId}:first-useful`).length || performance.getEntriesByName(`chat:${runId}:react-commit-observed`).length) return;
    performance.mark(`chat:${runId}:react-commit-observed`);
    performance.measure(`chat:${runId}:first-useful-to-react-commit-observed`, `chat:${runId}:first-useful`, `chat:${runId}:react-commit-observed`);
  }, [activeRunForSelection, liveAnswerByRun, liveProgressByRun, selectedAgentId, session.sessionId]);

  // Composer acceptance follows HTTP success; the returned promise tracks run completion.
  const sendMessage = async (draftOverride?: string, onAccepted?: () => void) => {
    const message = (draftOverride ?? session.draft).trim();
    if ((!message && !session.attached.length) || !selectedAgentId || !session.sessionId || activeRunForSelection || streamAbortRef.current[runKey(selectedAgentId, session.sessionId)]) return;
    const transientContextCommand = /^\/context(?:\s+full)?$/i.test(message);
    const target = { agentId: selectedAgentId, resourceAgentId: selected?.resourceId ?? selectedAgentId, sessionId: session.sessionId };
    const sentAt = performance.now();
    const runId = createRunId(target.sessionId);
    const provider = savedProviders.find((item) => item.provider === selected?.provider) ?? savedProviders[0];
    const model = selected?.model || provider?.models[0];
    const attachments = session.attached;
    const requestBody = { agentId: target.resourceAgentId, sessionId: target.sessionId, runId, message, ...(attachments.length ? { attachments } : {}), reasoningEffort: selected?.effort, temperature: selected?.temperature, ...(model && provider ? { model, modelConnectionId: provider.id } : {}) };
    const abortController = new AbortController();
    const targetKey = runKey(target.agentId, target.sessionId);
    streamAbortRef.current[targetKey] = abortController;
    setActiveRuns((current) => ({ ...current, [targetKey]: { runId, ...target, stage: 'accepted' } }));
    setLiveProgressByRun((current) => ({ ...current, [targetKey]: [] }));
    setLiveAnswerByRun((current) => ({ ...current, [targetKey]: '' }));
    setAgentActivity(target.agentId, 'thinking'); session.clearError();
    const appendVisibleTurn = transientContextCommand ? session.appendTransientTurn : session.appendTurn;
    const acceptSubmission = () => {
      if (abortController.signal.aborted || streamAbortRef.current[targetKey] !== abortController) return;
      if (onAccepted) onAccepted();
      else { session.setDraft(''); session.clearAttachment(); }
      session.leaveNewSessionForMessage();
      appendVisibleTurn(target.agentId, target.sessionId, { type: 'message', role: 'user', content: message, ts: new Date().toISOString(), runId, ...(attachments.length ? { metadata: { attachments: attachments.map(({ name, type, size }, index) => ({ index, name, type, size, encoding: 'data-url', ...(type.startsWith('image/') ? { preview: attachments[index].content } : {}) })) } } : {}) });
    };
    performance.mark(`chat:${runId}:send`, { startTime: sentAt });
    let firstUseful = false;
    let streamedAnswer = ''; let progressEntries: ProgressEntry[] = []; let toolSequence = 0; let frame = 0;
    const flushLiveText = () => { frame = 0; if (streamAbortRef.current[targetKey] !== abortController || abortController.signal.aborted) return; setLiveProgressByRun((current) => ({ ...current, [targetKey]: progressEntries })); setLiveAnswerByRun((current) => ({ ...current, [targetKey]: streamedAnswer })); };
    const scheduleLiveFlush = () => { if (!frame) frame = requestAnimationFrame(flushLiveText); };
    try {
      const handleEvent = (event: unknown) => {
        if (streamAbortRef.current[targetKey] !== abortController || abortController.signal.aborted || !event || typeof event !== 'object') return;
        const envelope = event as { type?: string; runId?: unknown; sessionId?: unknown; ts?: unknown; data?: { delta?: unknown; response?: unknown; message?: unknown; status?: unknown; modelCall?: unknown } & StreamToolEvent };
        if ((envelope.runId !== undefined && envelope.runId !== runId) || (envelope.sessionId !== undefined && envelope.sessionId !== target.sessionId)) return;
        const useful = ((envelope.type === 'assistant.delta' || envelope.type === 'assistant.thought') && typeof envelope.data?.delta === 'string' && envelope.data.delta.length > 0) || ((envelope.type === 'tool.started' || envelope.type === 'tool.completed') && typeof envelope.data?.tool === 'string' && Boolean(envelope.data.tool.trim()));
        if (useful && !firstUseful) { firstUseful = true; performance.mark(`chat:${runId}:first-useful`); performance.measure(`chat:${runId}:send-to-first-useful`, `chat:${runId}:send`, `chat:${runId}:first-useful`); }
        setActiveRuns((current) => {
          const owner = current[targetKey];
          if (owner?.runId !== runId) return current;
          const projection = projectLiveStage(owner.projection ?? { stage: owner.stage }, envelope);
          return { ...current, [targetKey]: { ...owner, stage: projection.stage, projection } };
        });
        if (envelope.type === 'assistant.thought' && typeof envelope.data?.delta === 'string') {
          progressEntries = appendThoughtDelta(progressEntries, envelope, runId);
          scheduleLiveFlush();
        } else if (envelope.type === 'assistant.delta' && typeof envelope.data?.delta === 'string') {
          streamedAnswer += envelope.data.delta; scheduleLiveFlush();
        } else if (envelope.type === 'tool.started' || envelope.type === 'tool.completed') {
          const data = envelope.data ?? {}; const tool = typeof data.tool === 'string' ? data.tool.trim() : '';
          if (!tool) return;
          const identity = chatToolIdentity(data);
          const label = identity?.label ?? (typeof data.label === 'string' && data.label.trim() ? data.label.trim() : tool.replace(/[-_]/g, ' '));
          const activityId = typeof data.activityId === 'string' && data.activityId ? data.activityId : `${runId}:tool:${++toolSequence}`;
          const previous = session.toolActivityForRun(runId); const items = [...(previous?.items ?? [])];
          const index = items.findIndex((item) => item.id === activityId);
          const status: ToolActivityItem['status'] = envelope.type === 'tool.started' ? 'pending' : data.ok === false || data.status === 'failed' ? 'error' : 'ok';
          const detailSource = identity ? identity.detail : data.detail ?? data.command ?? data.filePath ?? data.dirPath ?? data.query ?? data.result ?? data.output ?? data.error;
          const detail = typeof detailSource === 'string' ? detailSource : detailSource == null ? undefined : JSON.stringify(detailSource, null, 2);
          const item: ToolActivityItem = { id: activityId, label, status, ...(detail === undefined ? {} : { detail }) };
          if (index >= 0) items[index] = { ...items[index], ...item }; else items.push(item);
          const hasError = items.some((entry) => entry.status === 'error'); const hasPending = items.some((entry) => entry.status === 'pending');
          session.storeToolActivity({ runId, items, status: hasError ? 'warn' : hasPending ? 'running' : 'ok' });
        }
      };
      const { terminalType, finalResult } = await streamChat({ requestBody, signal: abortController.signal, onEvent: handleEvent, onAccepted: acceptSubmission });
      if (streamAbortRef.current[targetKey] !== abortController || abortController.signal.aborted) return;
      if (frame) { cancelAnimationFrame(frame); flushLiveText(); }
      const runStatus: NonNullable<RunProgress['status']> = terminalType === 'run.failed' ? 'failed' : terminalType === 'run.cancelled' ? 'cancelled' : terminalType === 'run.superseded' ? 'superseded' : 'complete';
      const terminalError = runStatus === 'complete' ? '' : answerFromChatResult(finalResult);
      if (runStatus === 'superseded') {
        // Supersession transfers transcript ownership to the newer recovered
        // run. Close this run's optimistic/live records without turning that
        // control-flow boundary into an assistant error at the bottom.
        session.clearRunState(target.agentId, target.sessionId, runId);
      } else {
        const failedMessage = terminalError.replace(/^Request failed:\s*/, '').trim() || 'The runtime could not complete the message.';
        const answer = runStatus === 'complete' ? answerFromChatResult(finalResult) || streamedAnswer : `[model_error: ${failedMessage}]`;
        const activity = session.toolActivityForRun(runId);
        const progress = finalizeThoughtProgress(progressEntries, runStatus, answer);
        // The streamed visible response is a separate, secondary record. Keep it
        // out of the authoritative final answer, even when a provider's terminal
        // answer differs from the text it streamed along the way.
        const retainedStream = runStatus === 'complete' && streamedAnswer.trim()
          ? trimStreamedAnswer(streamedAnswer, answer) || undefined
          : streamedAnswer.trim() || undefined;
        const metadata = activity?.items?.length || progress || retainedStream
          ? { ...(activity?.items?.length ? { toolActivity: activity } : {}), ...(progress ? { progress } : {}), ...(retainedStream ? { streamedAnswer: retainedStream } : {}) }
          : undefined;
        appendVisibleTurn(target.agentId, target.sessionId, { type: 'message', role: 'assistant', content: answer, ts: new Date().toISOString(), runId, metadata });
      }
      setLiveProgressByRun((current) => { const next = { ...current }; delete next[targetKey]; return next; });
      setLiveAnswerByRun((current) => { const next = { ...current }; delete next[targetKey]; return next; });
      setActiveRuns((current) => { const next = { ...current }; if (next[targetKey]?.runId === runId) delete next[targetKey]; return next; });
      void Promise.all([
        session.refreshSessions(target.agentId),
        ...(transientContextCommand ? [] : [session.refreshConversation(target.agentId, target.sessionId)]),
      ]).catch((error) => session.reportError(error instanceof Error ? `Could not refresh chat: ${error.message}` : 'Could not refresh chat.'));
      if (runStatus === 'failed' || runStatus === 'cancelled') throw new Error(runStatus === 'cancelled' ? 'Run cancelled.' : terminalError.replace(/^Request failed:\s*/, '') || 'Run failed.');
    } catch (error) {
      if (streamAbortRef.current[targetKey] === abortController && !abortController.signal.aborted && !(error instanceof DOMException && error.name === 'AbortError')) session.reportError(error instanceof Error ? `Message failed: ${error.message}` : 'Message failed.');
    } finally {
      if (frame) cancelAnimationFrame(frame);
      // A stopped stream may settle after a replacement started in this session.
      if (streamAbortRef.current[targetKey] === abortController) {
        delete streamAbortRef.current[targetKey];
        setLiveProgressByRun((current) => { const next = { ...current }; delete next[targetKey]; return next; });
        setLiveAnswerByRun((current) => { const next = { ...current }; delete next[targetKey]; return next; });
        setAgentActivity(target.agentId, 'idle'); setActiveRuns((current) => { const next = { ...current }; if (next[targetKey]?.runId === runId) delete next[targetKey]; return next; });
      }
    }
  };

  const cancelController = useRef<AbortController | null>(null);
  useEffect(() => () => { cancelController.current?.abort(); }, [selectedAgentId, selected?.id, session.sessionId]);
  const cancelRun = async () => {
    if (!activeRunForSelection) return;
    const run = activeRunForSelection;
    const targetKey = runKey(run.agentId, run.sessionId);
    const streamController = streamAbortRef.current[targetKey];
    const resourceAgentId = selected?.resourceId ?? run.agentId;
    // Stop owns this exact local run even if navigation aborts the request
    // observer. Retire the stream immediately; the runtime projection/polling
    // remains authoritative if cancellation itself fails.
    if (streamAbortRef.current[targetKey] === streamController) {
      streamController?.abort();
      delete streamAbortRef.current[targetKey];
      setActiveRuns((current) => { if (current[targetKey]?.runId !== run.runId) return current; const next = { ...current }; delete next[targetKey]; return next; });
      setLiveProgressByRun((current) => { const next = { ...current }; delete next[targetKey]; return next; });
      setLiveAnswerByRun((current) => { const next = { ...current }; delete next[targetKey]; return next; });
      setAgentActivity(run.agentId, 'idle');
    }
    cancelController.current?.abort();
    const controller = new AbortController(); cancelController.current = controller;
    try {
      await api(`/api/chat/${encodeURIComponent(run.runId)}/cancel`, { signal: controller.signal, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentId: resourceAgentId, reason: 'Stopped by operator' }) });
    } catch (error) {
      if (controller.signal.aborted) return;
      if (!isChatRunNotFoundError(error)) {
        session.reportError(error instanceof Error ? `Could not stop run: ${error.message}` : 'Could not stop run.');
        return;
      }
    }
    if (controller.signal.aborted) return;
    // Acknowledged Stop (including an already-gone run) is a terminal runtime
    // projection boundary. Local stream ownership was retired at request start.
    onRunStopped?.({ agentId: resourceAgentId, sessionId: run.sessionId, runId: run.runId });
    void Promise.all([session.refreshSessions(run.agentId), session.refreshConversation(run.agentId, run.sessionId)])
      .catch((error) => session.reportError(error instanceof Error ? `Could not refresh chat: ${error.message}` : 'Could not refresh chat.'));
  };

  return { liveStage: activeRunForSelection?.stage, activeRunForSelection, activeRunId: activeRunForSelection?.runId ?? '', sendMessage, cancelRun, liveProgress: activeRunForSelection ? liveProgressByRun[runKey(activeRunForSelection.agentId, activeRunForSelection.sessionId)] ?? [] : [], liveAnswer: activeRunForSelection ? liveAnswerByRun[runKey(activeRunForSelection.agentId, activeRunForSelection.sessionId)] ?? '' : '' };
}
