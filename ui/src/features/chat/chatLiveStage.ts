/** Operational evidence only: model.started is request intent, not dispatch. */
export type ChatLiveStage = 'accepted' | 'preparing' | 'request-intent' | 'dispatched' | 'model-completed';
export function chatLiveStageFromEvent(current: ChatLiveStage | undefined, type?: string): ChatLiveStage | undefined {
  if (type === 'run.started' || type === 'route.decided') return current && current !== 'accepted' ? current : 'preparing';
  if (type === 'model.started') return 'request-intent';
  if (type === 'model.dispatched') return current === 'model-completed' ? current : 'dispatched';
  if (type === 'model.completed') return 'model-completed';
  return current;
}
export function chatLiveStageLabel(stage?: ChatLiveStage) {
  switch (stage) {
    case 'accepted': return 'Waiting for runtime…';
    case 'preparing': return 'Preparing response…';
    case 'request-intent': return 'Model request prepared…';
    case 'dispatched': return 'Model request dispatched…';
    case 'model-completed': return 'Model response received; continuing…';
    default: return 'Waiting for progress…';
  }
}

export type LiveStageEvent = { type?: string; runId?: unknown; sessionId?: unknown; data?: { modelCall?: unknown } };
export type LiveStageProjection = { stage?: ChatLiveStage; modelCall?: number; useful?: boolean };
/** Async dispatch diagnostics cannot rewind a newer call or useful progress. */
export function projectLiveStage(current: LiveStageProjection, event: LiveStageEvent): LiveStageProjection {
  const call = typeof event.data?.modelCall === 'number' && Number.isFinite(event.data.modelCall) ? event.data.modelCall : undefined;
  if (call !== undefined && current.modelCall !== undefined && call < current.modelCall) return current;
  const newer = call !== undefined && (current.modelCall === undefined || call > current.modelCall);
  const next = newer ? { stage: current.stage, modelCall: call, useful: false } : { ...current };
  if (event.type === 'model.dispatched' && (call === undefined || next.useful || (!newer && next.stage === 'model-completed'))) return current;
  if (['assistant.delta', 'assistant.thought', 'tool.started', 'tool.completed'].includes(event.type ?? '')) next.useful = true;
  if (newer && event.type === 'model.dispatched') next.stage = 'dispatched';
  else if (event.type !== 'model.started' || newer || (!next.useful && next.stage !== 'dispatched' && next.stage !== 'model-completed')) next.stage = chatLiveStageFromEvent(next.stage, event.type);
  return next;
}
