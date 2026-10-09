/** Operational evidence only: model.started is request intent, not dispatch. */
export type ChatLiveStage = 'accepted' | 'preparing' | 'request-intent' | 'model-completed';
export function chatLiveStageFromEvent(current: ChatLiveStage | undefined, type?: string): ChatLiveStage | undefined {
  if (type === 'run.started' || type === 'route.decided') return current && current !== 'accepted' ? current : 'preparing';
  if (type === 'model.started') return 'request-intent';
  if (type === 'model.completed') return 'model-completed';
  return current;
}
export function chatLiveStageLabel(stage?: ChatLiveStage) {
  switch (stage) {
    case 'accepted': return 'Waiting for runtime…';
    case 'preparing': return 'Preparing response…';
    case 'request-intent': return 'Model request prepared…';
    case 'model-completed': return 'Model response received; continuing…';
    default: return 'Waiting for progress…';
  }
}
