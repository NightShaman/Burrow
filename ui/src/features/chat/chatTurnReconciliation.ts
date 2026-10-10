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
  const missingCachedTurns = cachedTurns.filter((turn) => turn.runId && serverTurns.some((server) => server.runId === turn.runId) && !serverTurnKeys.has(`${turn.runId}:${turn.role}`));
  const cachedTurnsByRunAndRole = new Map(cachedTurns.filter((turn) => turn.runId && turn.role).map((turn) => [`${turn.runId}:${turn.role}`, turn]));
  const mergedServerTurns = serverTurns.map((turn) => {
    const cached = turn.runId && turn.role ? cachedTurnsByRunAndRole.get(`${turn.runId}:${turn.role}`) : undefined;
    const streamedAnswer = turn.role === 'assistant' && !turn.metadata?.streamedAnswer ? cached?.metadata?.streamedAnswer : undefined;
    const progress = turn.role === 'assistant' && !turn.metadata?.progress ? cached?.metadata?.progress : undefined;
    const attachments = !turn.metadata?.attachments?.length ? cached?.metadata?.attachments : turn.metadata.attachments.map((attachment, index) => {
      const pending = cached?.metadata?.attachments?.find((item) => item.index === (attachment.index ?? index) && item.name === attachment.name);
      return pending?.preview && attachment.type.startsWith('image/') ? { ...attachment, preview: pending.preview } : attachment;
    });
    return streamedAnswer || progress || attachments
      ? { ...turn, metadata: { ...turn.metadata, ...(streamedAnswer ? { streamedAnswer } : {}), ...(progress ? { progress } : {}), ...(attachments ? { attachments } : {}) } }
      : turn;
  });
  if (!missingCachedTurns.length) return mergedServerTurns;
  return [...mergedServerTurns, ...missingCachedTurns].sort((a, b) => {
    const aTime = a.ts ? Date.parse(a.ts) : 0;
    const bTime = b.ts ? Date.parse(b.ts) : 0;
    return (Number.isNaN(aTime) ? 0 : aTime) - (Number.isNaN(bTime) ? 0 : bTime);
  });
}

export function reconcileSessionTurns(session: ChatSession, cachedTurns: SessionTurn[], pendingTurns: SessionTurn[] = []): SessionTurn[] {
  const reconciled = reconcileConversationTurns(
    mergeSessionActivities(session.turns ?? [], session.activities ?? []),
    cachedTurnsForSession(session, cachedTurns),
  );
  // Only current-tab submitted turns may bridge an absent server run. Durable
  // cache entries alone must never resurrect purged history.
  const missing = cachedTurnsForSession(session, pendingTurns).filter((pending) => !reconciled.some((turn) => turn.runId === pending.runId && turn.role === pending.role));
  return [...reconciled, ...missing];
}

// Lifecycle/provider events share the steering id, but are not user bubbles.
// Fold their status into the original chat entry rather than replacing it with
// an overlay at the end of the transcript (or using delivery time for ordering).
export function reconcileSteeringTurns(turns: SessionTurn[], inputs: import('./useLiveSteering').SteeringInput[]): SessionTurn[] {
  const statuses = new Map<string, string>();
  const updateStatus = (id: string, status: string) => {
    if (!statuses.has(id) || status !== 'pending') statuses.set(id, status);
  };
  for (const turn of turns) {
    const steering = turn.metadata?.steering;
    if (steering) updateStatus(steering.id, steering.status);
  }
  for (const input of inputs) updateStatus(input.id, input.status);
  const seen = new Set<string>();
  const merged: SessionTurn[] = [];
  for (const turn of turns) {
    const steering = turn.metadata?.steering;
    const isUserEntry = steering && turn.role === 'user' && turn.metadata?.visibility !== 'debug'
      && (turn.type === 'message' || (turn.type === 'event' && turn.metadata?.visibility === 'chat'));
    if (!isUserEntry) { merged.push(turn); continue; }
    if (seen.has(steering.id)) continue;
    seen.add(steering.id);
    merged.push({...turn, ts: steering.createdAt ?? turn.ts, metadata: {...turn.metadata, steering: {...steering, status: statuses.get(steering.id)!}}});
  }
  for (const input of inputs) {
    if (seen.has(input.id)) continue;
    seen.add(input.id);
    merged.push({type: 'message', role: 'user', content: input.message, ts: input.createdAt,
      metadata: {steering: {id: input.id, status: statuses.get(input.id)!}}});
  }
  // Stable ties preserve session order. Undated legacy turns keep their relative
  // position; only dated entries participate in chronological ordering.
  const dated = merged.filter(turn => Number.isFinite(Date.parse(turn.ts ?? '')))
    .sort((a, b) => Date.parse(a.ts!) - Date.parse(b.ts!));
  let index = 0;
  return merged.map(turn => Number.isFinite(Date.parse(turn.ts ?? '')) ? dated[index++] : turn);
}
