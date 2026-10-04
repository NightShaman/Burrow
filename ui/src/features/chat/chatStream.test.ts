import { expect, it, vi } from 'vitest';
import { streamChat } from './chatStream';
vi.mock('../../app/api', () => ({ fetchApiForTarget: vi.fn(), answerFromChatResult: () => 'error' }));
import { fetchApiForTarget } from '../../app/api';

it('settles on the first terminal envelope without EOF and cancels the reader', async () => {
  const cancel = vi.fn();
  const body = new ReadableStream({ start(c) {
    c.enqueue(new TextEncoder().encode('{"type":"run.completed","data":{"response":"ok"}}\n{"type":"late"}\n'));
  }, cancel });
  vi.mocked(fetchApiForTarget).mockResolvedValue(new Response(body, { headers: { 'content-type': 'application/x-ndjson' } }));
  const onEvent = vi.fn();
  const result = await Promise.race([streamChat({ requestBody: {}, signal: new AbortController().signal, onEvent }), new Promise(resolve => setTimeout(() => resolve('hung'), 100))]);
  expect(result).toEqual({ terminalType: 'run.completed', finalResult: 'ok' });
  expect(cancel).toHaveBeenCalled();
  expect(onEvent).toHaveBeenCalledTimes(1);
});

it('rejects EOF without a terminal envelope', async () => {
  vi.mocked(fetchApiForTarget).mockResolvedValue(new Response('{"type":"delta"}\n', { headers: { 'content-type': 'application/x-ndjson' } }));
  await expect(streamChat({ requestBody: {}, signal: new AbortController().signal, onEvent: vi.fn() })).rejects.toThrow('without a terminal');
});
