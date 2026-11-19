import { expect, it, vi } from 'vitest';
import { streamChat } from './chatStream';
vi.mock('../../app/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../app/api')>()),
  fetchApi: vi.fn(),
}));
import { fetchApi } from '../../app/api';

it('settles on the first terminal envelope without EOF and cancels the reader', async () => {
  const cancel = vi.fn();
  const body = new ReadableStream({
    start(c) {
      c.enqueue(
        new TextEncoder().encode(
          '{"type":"run.completed","data":{"response":"ok"}}\n{"type":"late"}\n',
        ),
      );
    },
    cancel,
  });
  vi.mocked(fetchApi).mockResolvedValue(
    new Response(body, { headers: { 'content-type': 'application/x-ndjson' } }),
  );
  const onEvent = vi.fn();
  const result = await Promise.race([
    streamChat({ requestBody: {}, signal: new AbortController().signal, onEvent }),
    new Promise((resolve) => setTimeout(() => resolve('hung'), 100)),
  ]);
  expect(result).toEqual({ terminalType: 'run.completed', finalResult: 'ok' });
  expect(cancel).toHaveBeenCalled();
  expect(onEvent).toHaveBeenCalledTimes(1);
});

it('rejects EOF without a terminal envelope', async () => {
  vi.mocked(fetchApi).mockResolvedValue(
    new Response('{"type":"delta"}\n', { headers: { 'content-type': 'application/x-ndjson' } }),
  );
  await expect(
    streamChat({ requestBody: {}, signal: new AbortController().signal, onEvent: vi.fn() }),
  ).rejects.toThrow('without a terminal');
});

it('does not accept rejected HTTP submissions (including busy409)', async () => {
  vi.mocked(fetchApi).mockResolvedValue(
    new Response(JSON.stringify({ error: 'chat_session_busy_use_explicit_intent' }), {
      status: 409,
    }),
  );
  const accepted = vi.fn();
  await expect(
    streamChat({
      requestBody: {},
      signal: new AbortController().signal,
      onEvent: vi.fn(),
      onAccepted: accepted,
    }),
  ).rejects.toThrow();
  expect(accepted).not.toHaveBeenCalled();
});
it('accepts after HTTP success, before any stream output', async () => {
  vi.mocked(fetchApi).mockResolvedValue(
    new Response('{"type":"run.completed","data":{"response":"ok"}}\n', {
      headers: { 'content-type': 'application/x-ndjson' },
    }),
  );
  const order: string[] = [];
  await streamChat({
    requestBody: {},
    signal: new AbortController().signal,
    onAccepted: () => order.push('accepted'),
    onEvent: () => order.push('event'),
  });
  expect(order).toEqual(['accepted', 'event']);
});

it.each(['failed', 'cancelled', 'superseded'] as const)(
  'classifies a successful JSON transport with a %s structured result as non-success',
  async (status) => {
    vi.mocked(fetchApi).mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          result: { chatResultVersion: 2, terminalStatus: status, answerText: '' },
        }),
        {
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
    const accepted = vi.fn();
    const response = await streamChat({
      requestBody: {},
      signal: new AbortController().signal,
      onEvent: vi.fn(),
      onAccepted: accepted,
    });
    expect(accepted).toHaveBeenCalledOnce();
    expect(response.terminalType).toBe(`run.${status}`);
  },
);

it('classifies a JSON failed result with nested ok:false even without v2 fields', async () => {
  vi.mocked(fetchApi).mockResolvedValue(
    new Response(JSON.stringify({ ok: true, result: { ok: false } })),
  );
  expect(
    (await streamChat({ requestBody: {}, signal: new AbortController().signal, onEvent: vi.fn() }))
      .terminalType,
  ).toBe('run.failed');
});

it('rejects malformed stream content without fabricating a terminal answer', async () => {
  const cancel = vi.fn();
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{broken-json}\n'));
    },
    cancel,
  });
  const response = new Response(body, { headers: { 'content-type': 'application/x-ndjson' } });
  vi.mocked(fetchApi).mockResolvedValue(response);
  await expect(
    streamChat({ requestBody: {}, signal: new AbortController().signal, onEvent: vi.fn() }),
  ).rejects.toThrow('streaming response was malformed');
  expect(cancel).toHaveBeenCalledOnce();
  expect(response.body?.locked).toBe(false);
});

it.each([
  ['chat_session_busy_use_explicit_intent', 409],
  [{ message: 'Selected model is not configured', code: 'model_configuration_invalid' }, 400],
])(
  'preserves rejected submission diagnostic %j without accepting the run',
  async (error, status) => {
    vi.mocked(fetchApi).mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error }), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const onAccepted = vi.fn();
    const pending = streamChat({
      requestBody: {},
      signal: new AbortController().signal,
      onEvent: vi.fn(),
      onAccepted,
    });
    await expect(pending).rejects.toMatchObject({
      message: typeof error === 'string' ? error : error.message,
      status,
    });
    expect(onAccepted).not.toHaveBeenCalled();
  },
);

it('ignores terminal events for another run or session before accepting its own', async () => {
  const events = [
    { type: 'run.completed', runId: 'other', sessionId: 'ours' },
    { type: 'run.failed', runId: 'ours', sessionId: 'other' },
    { type: 'run.completed', runId: 'ours', sessionId: 'ours', data: { response: 'right' } },
  ];
  const response = new Response(events.map((event) => JSON.stringify(event)).join('\n'), {
    headers: { 'content-type': 'application/x-ndjson' },
  });
  vi.mocked(fetchApi).mockResolvedValue(response);
  const onEvent = vi.fn();
  await expect(
    streamChat({
      requestBody: {},
      owner: { runId: 'ours', sessionId: 'ours' },
      signal: new AbortController().signal,
      onEvent,
    }),
  ).resolves.toEqual({ terminalType: 'run.completed', finalResult: 'right' });
  expect(onEvent).toHaveBeenCalledExactlyOnceWith(events[2]);
  expect(response.body?.locked).toBe(false);
});
