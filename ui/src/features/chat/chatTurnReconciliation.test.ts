import { describe, expect, it } from 'vitest';
import type { ChatSession, SessionTurn } from '../../app/api';
import { cachedTurnsForSession, mergeSessionActivities, reconcileConversationTurns, reconcileSessionTurns } from './chatTurnReconciliation';

const turn = (role: 'user' | 'assistant', content: string, runId: string, ts: string, metadata?: SessionTurn['metadata']): SessionTurn => ({ role, content, runId, ts, metadata });

describe('chat turn reconciliation', () => {
  it.each([
    {
      name: 'keeps cached turns when no reset boundary exists',
      session: { id: 'default' } satisfies ChatSession,
      cached: [turn('assistant', 'cached', 'run-1', '2026-08-25T12:00:00.000Z')],
      expected: ['cached'],
    },
    {
      name: 'discards cached turns before a valid reset boundary',
      session: { id: 'default', metadata: { resetAt: '2026-08-26T10:00:00.000Z' } } satisfies ChatSession,
      cached: [
        turn('assistant', 'old', 'run-old', '2026-08-25T12:00:00.000Z'),
        turn('user', 'new', 'run-new', '2026-08-26T10:00:01.000Z'),
      ],
      expected: ['new'],
    },
    {
      name: 'discards undated turns after a reset because their generation is unknowable',
      session: { id: 'default', metadata: { resetAt: '2026-08-26T10:00:00.000Z' } } satisfies ChatSession,
      cached: [{ role: 'assistant', content: 'undated', runId: 'run-undated' }],
      expected: [],
    },
    {
      name: 'does not invalidate turns for malformed reset metadata',
      session: { id: 'default', metadata: { resetAt: 'not-a-date' } } satisfies ChatSession,
      cached: [turn('assistant', 'cached', 'run-1', '2026-08-25T12:00:00.000Z')],
      expected: ['cached'],
    },
  ])('$name', ({ session, cached, expected }) => {
    expect(cachedTurnsForSession(session, cached).map((item) => item.content)).toEqual(expected);
  });

  it('keeps the missing optimistic half of a partially persisted run', () => {
    const cached = [
      turn('user', 'Question', 'run-1', '2026-08-26T10:00:00.000Z'),
      turn('assistant', 'Local answer', 'run-1', '2026-08-26T10:00:01.000Z'),
    ];
    const server = [turn('assistant', 'Persisted answer', 'run-1', '2026-08-26T10:00:01.000Z')];

    expect(reconcileConversationTurns(server, cached)).toEqual([
      cached[0],
      server[0],
    ]);
  });

  it('retains optimistic attachment metadata until the server snapshot catches up', () => {
    const attachments = [{ name: 'diagram.png', type: 'image/png', size: 42 }];
    const cached = [turn('user', 'See attachment', 'run-1', '2026-08-26T10:00:00.000Z', { attachments })];
    const server = [turn('user', 'See attachment', 'run-1', '2026-08-26T10:00:00.000Z')];

    expect(reconcileConversationTurns(server, cached)[0].metadata?.attachments).toEqual(attachments);
  });

  it('prefers attachment metadata already persisted by the server', () => {
    const cachedAttachments = [{ name: 'local.png', type: 'image/png', size: 42 }];
    const serverAttachments = [{ name: 'server.png', type: 'image/png', size: 43 }];
    const cached = [turn('user', 'See attachment', 'run-1', '2026-08-26T10:00:00.000Z', { attachments: cachedAttachments })];
    const server = [turn('user', 'See attachment', 'run-1', '2026-08-26T10:00:00.000Z', { attachments: serverAttachments })];

    expect(reconcileConversationTurns(server, cached)[0].metadata?.attachments).toEqual(serverAttachments);
  });

  it('retains a streamed answer until the server persists it', () => {
    const cached = [turn('assistant', 'Answer', 'run-1', '2026-08-26T10:00:00.000Z', { streamedAnswer: 'Streamed answer' })];
    const server = [turn('assistant', 'Answer', 'run-1', '2026-08-26T10:00:00.000Z')];

    expect(reconcileConversationTurns(server, cached)[0].metadata?.streamedAnswer).toBe('Streamed answer');
  });

  it('normalizes content and merges server tool activity', () => {
    const turns = mergeSessionActivities([{ role: 'assistant', content: 'Done', runId: 'run-1' }], [{
      runId: 'run-1',
      summary: 'Read files',
      items: [{ label: 'Read file', detail: 'app.ts', status: 'error' }],
    }]);

    expect(turns[0]).toMatchObject({
      content: 'Done',
      metadata: { toolActivity: { runId: 'run-1', summary: 'Read files', status: 'warn', items: [{ id: 'run-1:0', status: 'error' }] } },
    });
  });

  it('applies the reset boundary before reconciling a session', () => {
    const session: ChatSession = { id: 'default', metadata: { resetAt: '2026-08-26T10:00:00.000Z' }, turns: [] };
    const cached = [turn('assistant', 'Yesterday', 'old-run', '2026-08-25T10:00:00.000Z')];

    expect(reconcileSessionTurns(session, cached)).toEqual([]);
  });
});
