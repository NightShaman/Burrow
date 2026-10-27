import type { ChatAttachment, SessionTurn } from '../../app/api';

export type BusyIntent = 'queue_next' | 'steer' | 'side_question';
export type ChatInput = {
  id: string; intent: 'queue_next' | 'side_question';
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted' | 'held';
  agentId: string; sessionId: string; generation: number; targetRunId: string | null; runId: string;
  createdAt: string; startedAt: string | null; completedAt: string | null;
  message: string; attachments: ChatAttachment[];
  result: { ok: boolean; answerText: string | null; decision: string | null; blockers: string[] } | null;
  error: string | null; snapshot: { id: string | null; capturedAt: string | null; originRunId: string | null; phase: string | null; entryCount: number | null } | null;
  promotedFrom: string | null; position: number | null;
};
export type ChatInputMetadata = Pick<ChatInput, 'id' | 'intent'> & Partial<Pick<ChatInput, 'status' | 'snapshot' | 'runId' | 'createdAt' | 'position' | 'generation' | 'promotedFrom'>> & { projection?: boolean };
export const intentLabels: Record<BusyIntent, string> = { queue_next: 'Queue next', steer: 'Steer', side_question: 'Side question' };
export const pendingChatInput = (input: ChatInput) => ['queued', 'held', 'running'].includes(input.status);
export function chatInputLabel(input: ChatInputMetadata) {
  const status = input.status === 'queued' && input.intent === 'queue_next'
    ? `queued${input.position ? ` #${input.position}` : ''}` : input.status ?? '';
  return `${intentLabels[input.intent]}${status ? ` · ${status}` : ''}${input.snapshot?.capturedAt ? ` · snapshot at ${new Date(input.snapshot.capturedAt).toLocaleString()}` : ''}`;
}

/** Overlay durable inputs onto the existing transcript, not a second conversation store. */
export function reconcileChatInputs(turns: SessionTurn[], inputs: ChatInput[]): SessionTurn[] {
  const retained = new Map<string, ChatInputMetadata>();
  for (const turn of turns) {
    const input = turn.metadata?.chatInput;
    if (input) retained.set(input.id, { ...retained.get(input.id), ...input });
  }
  const byId = new Map(inputs.map(input => [input.id, input]));
  const projectedRuns = new Map(turns.filter(turn => turn.role === 'user' && turn.metadata?.chatInput?.projection && turn.runId).map(turn => [turn.metadata!.chatInput!.id, turn.runId]));
  const projectedAttachments = new Map(turns.filter(turn => turn.role === 'user' && turn.metadata?.chatInput?.projection && turn.metadata.attachments?.length).map(turn => [turn.metadata!.chatInput!.id, turn.metadata!.attachments!]));
  const userSeen = new Set<string>(), answerSeen = new Set<string>();
  const merged = turns.flatMap(turn => {
    const metadata = turn.metadata?.chatInput;
    if (!metadata) return [turn];
    const input = byId.get(metadata.id);
    // Runtime queue projections are the same operator input, not another bubble.
    if (turn.type !== 'message' && turn.role !== 'user') return [];
    if (turn.role === 'user') {
      if (userSeen.has(metadata.id)) return [];
      userSeen.add(metadata.id);
    } else if (turn.role === 'assistant') answerSeen.add(metadata.id);
    return [{ ...turn, ...(turn.role === 'user' ? { type: 'message', ts: input?.createdAt ?? turn.ts, runId: input?.runId ?? projectedRuns.get(metadata.id) ?? turn.runId } : {}),
      metadata: { ...turn.metadata, ...(projectedAttachments.has(metadata.id) && turn.role === 'user' ? { attachments: projectedAttachments.get(metadata.id) } : {}), chatInput: { ...metadata, ...retained.get(metadata.id), ...(input ? { status: input.status, snapshot: input.snapshot, position: input.position, createdAt: input.createdAt } : {}) } } }];
  });
  for (const input of inputs) {
    const metadata = { chatInput: input, ...(input.intent === 'side_question' ? { lane: 'side_question' as const } : {}) };
    if (!userSeen.has(input.id)) merged.push({ type: 'message', role: 'user', runId: input.runId, ts: input.createdAt, content: input.message,
      metadata: { ...metadata, attachments: input.attachments.map((file, index) => ({ ...file, index, preview: file.type.startsWith('image/') ? file.content : undefined })) } });
    if (input.intent === 'side_question' && input.result?.answerText && !answerSeen.has(input.id)) merged.push({ type: 'message', role: 'assistant', runId: input.runId, ts: input.completedAt ?? input.createdAt, content: input.result.answerText, metadata });
  }
  return merged.sort((a, b) => (Date.parse(a.ts ?? '') || 0) - (Date.parse(b.ts ?? '') || 0));
}
