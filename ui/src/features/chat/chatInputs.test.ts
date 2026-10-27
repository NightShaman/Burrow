import { expect, it } from 'vitest';
import { reconcileChatInputs, type ChatInput } from './chatInputs';
import type { SessionTurn } from '../../app/api';
export const queueInput: ChatInput = { id: 'input', intent: 'queue_next', status: 'queued', agentId: 'agent', sessionId: 'default', generation: 2, targetRunId: 'main', runId: 'queued-run', createdAt: '2026-10-26T12:00:00Z', startedAt: null, completedAt: null, message: 'Do this next', attachments: [], result: null, error: null, snapshot: null, promotedFrom: null, position: 1 };
it('folds queue lifecycle, initial event and runtime projection into one original-time message', () => {
 const turns: SessionTurn[] = [
  { type: 'event', role: 'user', content: queueInput.message, ts: queueInput.createdAt, metadata: { chatInput: queueInput } },
  { type: 'message', role: 'user', content: queueInput.message, ts: '2026-10-26T12:01:00Z', metadata: { chatInput: { id: 'input', intent: 'queue_next', projection: true }, attachments: [{ name: 'native.png', type: 'image/png', artifactPath: 'native.png' }] } },
  { type: 'event', role: null, metadata: { chatInput: { id: 'input', intent: 'queue_next', status: 'succeeded' } } },
 ];
 const result = reconcileChatInputs(turns, []);
 expect(result).toHaveLength(1); expect(result[0].ts).toBe(queueInput.createdAt);
 expect(result[0].metadata?.chatInput?.status).toBe('succeeded');
 expect(result[0].metadata?.attachments?.[0].artifactPath).toBe('native.png');
});
it('renders API side answers once and replaces them with retained native messages when available', () => {
 const input: ChatInput = { ...queueInput, intent: 'side_question', status: 'succeeded', result: { ok: true, answerText: 'Snapshot answer', decision: null, blockers: [] }, snapshot: { id: 'snapshot', capturedAt: queueInput.createdAt, originRunId: 'main', phase: 'thinking', entryCount: 3 } };
 const first = reconcileChatInputs([], [input]);
 expect(first.map(t => t.role)).toEqual(['user','assistant']);
 expect(first[1].metadata?.lane).toBe('side_question');
 const next = reconcileChatInputs(first, [input]); expect(next).toHaveLength(2);
});
