import { describe, expect, it } from 'vitest';
import { appendThoughtDelta, finalizeThoughtProgress, thoughtProgressFromEvents } from './chatThoughtProgress';

describe('chat thought progress', () => {
  it('coalesces contiguous provider deltas by model call with exact whitespace', () => {
    const progress = thoughtProgressFromEvents([
      { type: 'assistant.thought', ts: '2026-09-22T10:00:00.000Z', data: { delta: 'decide', modelCall: 1 } },
      { type: 'assistant.thought', data: { delta: ' which\n', modelCall: 1 } },
      { type: 'assistant.thought', data: { delta: 'second', modelCall: 2 } },
    ], 'run-1');

    expect(progress.map(({ text, modelCall }) => ({ text, modelCall }))).toEqual([
      { text: 'decide which\n', modelCall: 1 },
      { text: 'second', modelCall: 2 },
    ]);
  });

  it('retains distinct completed thoughts and removes only an exact normalized final-answer duplicate', () => {
    const entries = [
      { id: 'thought-1', text: 'Internal reasoning. ', ts: '2026-09-22T10:00:00.000Z', status: 'streaming' as const },
      { id: 'thought-2', text: 'Final\n answer.', ts: '2026-09-22T10:00:01.000Z', status: 'streaming' as const },
      { id: 'thought-3', text: 'Final answer with more', ts: '2026-09-22T10:00:02.000Z', status: 'streaming' as const },
    ];

    expect(finalizeThoughtProgress(entries, 'complete', 'Final answer.')).toEqual({
      status: 'complete',
      items: [
        expect.objectContaining({ id: 'thought-1', text: 'Internal reasoning. ', status: 'complete' }),
        expect.objectContaining({ id: 'thought-3', text: 'Final answer with more', status: 'complete' }),
      ],
    });
  });

  it('retains exact streamed thoughts on terminal failure and cancellation', () => {
    const entry = appendThoughtDelta([], { type: 'assistant.thought', data: { delta: 'partial\n thought', modelCall: 1 } }, 'run-1');
    expect(finalizeThoughtProgress(entry, 'failed', '[model_error: provider failed]')).toMatchObject({ status: 'failed', items: [expect.objectContaining({ text: 'partial\n thought' })] });
    expect(finalizeThoughtProgress(entry, 'cancelled', '[model_error: cancelled]')).toMatchObject({ status: 'cancelled', items: [expect.objectContaining({ text: 'partial\n thought' })] });
  });
});
