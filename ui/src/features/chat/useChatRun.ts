import { useRef, useState } from 'react';
import { answerFromChatResult, apiForTarget, createRunId, type ChatAttachment, type ProgressEntry, type RunProgress, type SessionTurn, type ToolActivityItem } from '../../app/api';
import { localApiTarget, type ApiTarget } from '../../app/apiTargets';
import type { Agent, SavedProvider } from '../../app/types';
import { streamChat } from './chatStream';

type ActiveRun = { runId: string; agentId: string; sessionId: string };
type StreamToolEvent = { tool?: unknown; rawTool?: unknown; activityId?: unknown; ok?: unknown; status?: unknown; label?: unknown; detail?: unknown; provider?: unknown; mcpToolName?: unknown; command?: unknown; cwd?: unknown; filePath?: unknown; dirPath?: unknown; query?: unknown; reason?: unknown; result?: unknown; output?: unknown; error?: unknown };

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
  storeToolActivity: (activity: { runId: string; items: ToolActivityItem[]; status: 'running' | 'ok' | 'warn' }) => void;
  toolActivityForRun: (runId: string) => { items?: ToolActivityItem[] } | undefined;
  refreshSessions: (agentId?: string) => Promise<void>;
  refreshConversation: (agentId?: string, sessionId?: string) => Promise<void>;
};

type UseChatRunOptions = {
  selectedAgentId: string;
  selected: Agent | undefined;
  selectedTarget?: ApiTarget;
  savedProviders: SavedProvider[];
  session: ChatRunSession;
  setAgentActivity: (agentId: string, status: string) => void;
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
export function useChatRun({ selectedAgentId, selected, selectedTarget = localApiTarget, savedProviders, session, setAgentActivity }: UseChatRunOptions) {
  const [activeRuns, setActiveRuns] = useState<Record<string, ActiveRun>>({});
  const [liveProgressByRun, setLiveProgressByRun] = useState<Record<string, ProgressEntry[]>>({});
  const [liveAnswerByRun, setLiveAnswerByRun] = useState<Record<string, string>>({});
  const streamAbortRef = useRef<Record<string, AbortController>>({});
  const activeRunForSelection = selectedAgentId && session.sessionId ? activeRuns[runKey(selectedAgentId, session.sessionId)] ?? null : null;

  const sendMessage = async () => {
    const message = session.draft.trim() || (session.attached.length ? 'Please analyze the attached files.' : '');
    if (!message || !selectedAgentId || !session.sessionId || activeRunForSelection) return;
    const target = { agentId: selectedAgentId, resourceAgentId: selected?.resourceId ?? selectedAgentId, sessionId: session.sessionId };
    const runId = createRunId(target.sessionId);
    const provider = savedProviders.find((item) => item.provider === selected?.provider) ?? savedProviders[0];
    const model = selected?.model || provider?.models[0];
    const attachments = session.attached;
    const requestBody = { agentId: target.resourceAgentId, sessionId: target.sessionId, runId, message, ...(attachments.length ? { attachments } : {}), reasoningEffort: selected?.effort, temperature: selected?.temperature, ...(model && provider && !selectedTarget.baseUrl ? { model, modelConnectionId: provider.id } : {}) };
    const abortController = new AbortController();
    const targetKey = runKey(target.agentId, target.sessionId);
    streamAbortRef.current[targetKey] = abortController;
    setActiveRuns((current) => ({ ...current, [targetKey]: { runId, ...target } }));
    setLiveProgressByRun((current) => ({ ...current, [targetKey]: [] }));
    setLiveAnswerByRun((current) => ({ ...current, [targetKey]: '' }));
    setAgentActivity(target.agentId, 'thinking'); session.clearError(); session.setDraft(''); session.clearAttachment(); session.leaveNewSessionForMessage();
    session.appendTurn(target.agentId, target.sessionId, { type: 'message', role: 'user', content: message, ts: new Date().toISOString(), runId, ...(attachments.length ? { metadata: { attachments: attachments.map(({ name, type, size }, index) => ({ index, name, type, size, encoding: 'data-url' })) } } : {}) });
    let streamedAnswer = ''; let progressEntries: ProgressEntry[] = []; let thoughtSequence = 0; let toolSequence = 0; let frame = 0;
    const flushLiveText = () => { frame = 0; setLiveProgressByRun((current) => ({ ...current, [targetKey]: progressEntries })); setLiveAnswerByRun((current) => ({ ...current, [targetKey]: streamedAnswer })); };
    const scheduleLiveFlush = () => { if (!frame) frame = requestAnimationFrame(flushLiveText); };
    try {
      const handleEvent = (event: unknown) => {
        if (!event || typeof event !== 'object') return;
        const envelope = event as { type?: string; ts?: unknown; data?: { delta?: unknown; response?: unknown; message?: unknown; status?: unknown; modelCall?: unknown } & StreamToolEvent };
        if (envelope.type === 'assistant.thought' && typeof envelope.data?.delta === 'string') {
          const modelCall = Number.isFinite(Number(envelope.data.modelCall)) ? Number(envelope.data.modelCall) : undefined;
          progressEntries = [...progressEntries, { id: `${runId}:thought:${++thoughtSequence}`, text: envelope.data.delta, ts: typeof envelope.ts === 'string' ? envelope.ts : new Date().toISOString(), ...(modelCall === undefined ? {} : { modelCall }), status: 'streaming' }];
          scheduleLiveFlush();
        } else if (envelope.type === 'assistant.delta' && typeof envelope.data?.delta === 'string') {
          streamedAnswer += envelope.data.delta; scheduleLiveFlush();
        } else if (envelope.type === 'tool.started' || envelope.type === 'tool.completed') {
          const data = envelope.data ?? {}; const tool = typeof data.tool === 'string' ? data.tool.trim() : '';
          if (!tool) return;
          const isMcpCall = tool === 'mcp_call';
          const provider = typeof data.provider === 'string' ? data.provider.trim() : '';
          const mcpToolName = typeof data.mcpToolName === 'string' ? data.mcpToolName.trim() : '';
          const label = isMcpCall && mcpToolName
            ? 'MCP tool'
            : typeof data.label === 'string' && data.label.trim() ? data.label.trim() : tool.replace(/[-_]/g, ' ');
          const activityId = typeof data.activityId === 'string' && data.activityId ? data.activityId : `${runId}:tool:${++toolSequence}`;
          const previous = session.toolActivityForRun(runId); const items = [...(previous?.items ?? [])];
          const index = items.findIndex((item) => item.id === activityId);
          const status: ToolActivityItem['status'] = envelope.type === 'tool.started' ? 'pending' : data.ok === false || data.status === 'failed' ? 'error' : 'ok';
          // MCP arguments and output can contain credentials or other protected
          // values. The provider and discovered tool name are the only MCP data
          // suitable for the transcript.
          const mcpDetail = [provider, mcpToolName].filter(Boolean).join(' · ');
          const detailSource = isMcpCall ? mcpDetail : data.detail ?? data.command ?? data.filePath ?? data.dirPath ?? data.query ?? data.result ?? data.output ?? data.error;
          const detail = typeof detailSource === 'string' ? detailSource : detailSource == null ? undefined : JSON.stringify(detailSource, null, 2);
          const item: ToolActivityItem = { id: activityId, label, status, ...(detail === undefined ? {} : { detail }) };
          if (index >= 0) items[index] = { ...items[index], ...item }; else items.push(item);
          const hasError = items.some((entry) => entry.status === 'error'); const hasPending = items.some((entry) => entry.status === 'pending');
          session.storeToolActivity({ runId, items, status: hasError ? 'warn' : hasPending ? 'running' : 'ok' });
        }
      };
      const { terminalType, finalResult } = await streamChat({ target: selectedTarget, requestBody, signal: abortController.signal, onEvent: handleEvent });
      if (frame) { cancelAnimationFrame(frame); flushLiveText(); }
      const runStatus: NonNullable<RunProgress['status']> = terminalType === 'run.failed' ? 'failed' : terminalType === 'run.cancelled' ? 'cancelled' : terminalType === 'run.superseded' ? 'superseded' : 'complete';
      const terminalError = runStatus === 'complete' ? '' : answerFromChatResult(finalResult);
      const failedMessage = terminalError.replace(/^Request failed:\s*/, '').trim() || 'The runtime could not complete the message.';
      const answer = runStatus === 'complete' ? answerFromChatResult(finalResult) || streamedAnswer : `[model_error: ${failedMessage}]`;
      const activity = session.toolActivityForRun(runId);
      const progress: RunProgress | undefined = progressEntries.length ? { items: progressEntries.map((entry) => ({ ...entry, status: 'complete' })), status: runStatus } : undefined;
      // The streamed visible response is a separate, secondary record. Keep it
      // out of the authoritative final answer, even when a provider's terminal
      // answer differs from the text it streamed along the way.
      const retainedStream = runStatus === 'complete' && streamedAnswer.trim()
        ? trimStreamedAnswer(streamedAnswer, answer) || undefined
        : streamedAnswer.trim() || undefined;
      const metadata = activity?.items?.length || progress || retainedStream
        ? { ...(activity?.items?.length ? { toolActivity: activity } : {}), ...(progress ? { progress } : {}), ...(retainedStream ? { streamedAnswer: retainedStream } : {}) }
        : undefined;
      session.appendTurn(target.agentId, target.sessionId, { type: 'message', role: 'assistant', content: answer, ts: new Date().toISOString(), runId, metadata });
      setLiveProgressByRun((current) => { const next = { ...current }; delete next[targetKey]; return next; });
      setLiveAnswerByRun((current) => { const next = { ...current }; delete next[targetKey]; return next; });
      setActiveRuns((current) => { const next = { ...current }; if (next[targetKey]?.runId === runId) delete next[targetKey]; return next; });
      void Promise.all([
        session.refreshSessions(target.agentId),
        session.refreshConversation(target.agentId, target.sessionId),
      ]).catch((error) => session.reportError(error instanceof Error ? `Could not refresh chat: ${error.message}` : 'Could not refresh chat.'));
      if (runStatus !== 'complete') throw new Error(runStatus === 'cancelled' ? 'Run cancelled.' : runStatus === 'superseded' ? 'Run superseded by a newer message.' : terminalError.replace(/^Request failed:\s*/, '') || 'Run failed.');
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) session.reportError(error instanceof Error ? `Message failed: ${error.message}` : 'Message failed.');
    } finally {
      if (frame) cancelAnimationFrame(frame);
      if (streamAbortRef.current[targetKey] === abortController) delete streamAbortRef.current[targetKey];
      setLiveProgressByRun((current) => { const next = { ...current }; delete next[targetKey]; return next; });
      setLiveAnswerByRun((current) => { const next = { ...current }; delete next[targetKey]; return next; });
      setAgentActivity(target.agentId, 'idle'); setActiveRuns((current) => { const next = { ...current }; if (next[targetKey]?.runId === runId) delete next[targetKey]; return next; });
    }
  };

  const cancelRun = async () => {
    if (!activeRunForSelection) return;
    const targetKey = runKey(activeRunForSelection.agentId, activeRunForSelection.sessionId);
    streamAbortRef.current[targetKey]?.abort();
    try { await apiForTarget(selectedTarget, `/api/chat/${encodeURIComponent(activeRunForSelection.runId)}/cancel`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentId: selected?.resourceId ?? activeRunForSelection.agentId, reason: 'Stopped by operator' }) }); }
    catch (error) { session.reportError(error instanceof Error ? `Could not stop run: ${error.message}` : 'Could not stop run.'); }
  };

  return { activeRunForSelection, activeRunId: activeRunForSelection?.runId ?? '', sendMessage, cancelRun, liveProgress: activeRunForSelection ? liveProgressByRun[runKey(activeRunForSelection.agentId, activeRunForSelection.sessionId)] ?? [] : [], liveAnswer: activeRunForSelection ? liveAnswerByRun[runKey(activeRunForSelection.agentId, activeRunForSelection.sessionId)] ?? '' : '' };
}
