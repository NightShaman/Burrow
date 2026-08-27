import { textFromChatValue, type ChatSession, type SessionToolActivity, type SessionTurn, type ToolActivity } from '../../app/api';

export function mergeSessionActivities(turns: SessionTurn[], activities: SessionToolActivity[]): SessionTurn[] {
  const activityByRun = new Map(activities.filter((activity) => activity.runId).map((activity) => [activity.runId, activity]));
  return turns.map((turn) => {
    if (turn.role !== 'assistant' || !turn.runId) return { ...turn, content: textFromChatValue(turn.content) };
    const activity = activityByRun.get(turn.runId);
    if (!activity) return { ...turn, content: textFromChatValue(turn.content) };
    const toolActivity: ToolActivity = {
      runId: activity.runId,
      summary: activity.summary,
      status: activity.items.some((item) => item.status === 'error') ? 'warn' : 'ok',
      items: activity.items.map((item, index) => ({ id: `${activity.runId}:${index}`, label: item.label, detail: item.detail, status: item.status })),
    };
    return { ...turn, content: textFromChatValue(turn.content), metadata: { ...turn.metadata, toolActivity } };
  });
}

export function cachedTurnsForSession(session: ChatSession, cachedTurns: SessionTurn[]): SessionTurn[] {
  const resetAt = session.metadata?.resetAt ? Date.parse(session.metadata.resetAt) : Number.NaN;
  if (Number.isNaN(resetAt)) return cachedTurns;
  // A reset keeps the session id but starts a new transcript generation. Cached
  // turns from the previous generation must not be treated as pending writes.
  return cachedTurns.filter((turn) => {
    const turnTime = turn.ts ? Date.parse(turn.ts) : Number.NaN;
    return !Number.isNaN(turnTime) && turnTime >= resetAt;
  });
}

export function reconcileConversationTurns(serverTurns: SessionTurn[], cachedTurns: SessionTurn[]): SessionTurn[] {
  // A run writes its user and assistant turns independently. A terminal
  // refresh can therefore see only one of them while persistence catches up;
  // treating the run id as one indivisible record would erase its missing mate.
  const serverTurnKeys = new Set(serverTurns.map((turn) => turn.runId ? `${turn.runId}:${turn.role}` : ''));
  const missingCachedTurns = cachedTurns.filter((turn) => turn.runId && !serverTurnKeys.has(`${turn.runId}:${turn.role}`));
  const cachedTurnsByRunAndRole = new Map(cachedTurns.filter((turn) => turn.runId && turn.role).map((turn) => [`${turn.runId}:${turn.role}`, turn]));
  const mergedServerTurns = serverTurns.map((turn) => {
    const cached = turn.runId && turn.role ? cachedTurnsByRunAndRole.get(`${turn.runId}:${turn.role}`) : undefined;
    const streamedAnswer = turn.role === 'assistant' && !turn.metadata?.streamedAnswer ? cached?.metadata?.streamedAnswer : undefined;
    const attachments = !turn.metadata?.attachments?.length ? cached?.metadata?.attachments : undefined;
    return streamedAnswer || attachments
      ? { ...turn, metadata: { ...turn.metadata, ...(streamedAnswer ? { streamedAnswer } : {}), ...(attachments ? { attachments } : {}) } }
      : turn;
  });
  if (!missingCachedTurns.length) return mergedServerTurns;
  return [...mergedServerTurns, ...missingCachedTurns].sort((a, b) => {
    const aTime = a.ts ? Date.parse(a.ts) : 0;
    const bTime = b.ts ? Date.parse(b.ts) : 0;
    return (Number.isNaN(aTime) ? 0 : aTime) - (Number.isNaN(bTime) ? 0 : bTime);
  });
}

export function reconcileSessionTurns(session: ChatSession, cachedTurns: SessionTurn[]): SessionTurn[] {
  return reconcileConversationTurns(
    mergeSessionActivities(session.turns ?? [], session.activities ?? []),
    cachedTurnsForSession(session, cachedTurns),
  );
}
