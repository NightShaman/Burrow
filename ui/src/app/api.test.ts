import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, fetchApi, generatedArtifactPath } from './api';
import { clearBasicCredentials, setBasicCredentials } from './auth';

describe('API requests', () => {
  afterEach(() => {
    clearBasicCredentials();
    vi.unstubAllGlobals();
  });

  it('adds Basic authentication to ordinary API requests', async () => {
    setBasicCredentials('goblin', 'secret');
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await api('/api/agents');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).get('authorization')).toBe('Basic Z29ibGluOnNlY3JldA==');
    expect(new Headers(init.headers).get('accept')).toBe('application/json');
  });

  it('encodes Unicode Basic credentials as UTF-8 bytes', async () => {
    setBasicCredentials('用户', 'päss🔐');
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await api('/api/agents');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).get('authorization')).toBe(`Basic ${btoa(String.fromCharCode(...new TextEncoder().encode('用户:päss🔐')))}`);
  });

  it('adds the same authentication to streaming requests without replacing their accept header', async () => {
    setBasicCredentials('goblin', 'secret');
    const fetchMock = vi.fn().mockResolvedValue(new Response());
    vi.stubGlobal('fetch', fetchMock);

    await fetchApi('/api/chat', { headers: { accept: 'application/x-ndjson', 'content-type': 'application/json' } });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).get('authorization')).toBe('Basic Z29ibGluOnNlY3JldA==');
    expect(new Headers(init.headers).get('accept')).toBe('application/x-ndjson');
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
  });

  it('encodes generated artifact route parameters without exposing reference path segments', () => {
    expect(generatedArtifactPath('agent / one', 'generated/audio take #1.wav')).toBe('/api/generated-artifacts/agent%20%2F%20one/generated%2Faudio%20take%20%231.wav');
  });



  it('aborts a request whose response body hangs until the deadline', async () => {
    vi.useFakeTimers();
    const abortSpy = vi.fn();
    const response = { status: 200, ok: true, headers: new Headers({ 'content-type': 'application/json' }), text: () => new Promise<string>((_resolve, reject) => abortSpy.mockImplementation(() => reject(new DOMException('Aborted', 'AbortError')))) } as unknown as Response;
    const fetchMock = vi.fn().mockImplementation((_path, init: RequestInit) => { init.signal?.addEventListener('abort', () => abortSpy()); return Promise.resolve(response); });
    vi.stubGlobal('fetch', fetchMock);
    const pending = api('/api/slow');
    await Promise.resolve(); await Promise.resolve();
    const expectation = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(30_000);
    await expectation;
    expect((fetchMock.mock.calls[0][1] as RequestInit).signal?.aborted).toBe(true);
    vi.useRealTimers();
  });

  it('combines caller cancellation with the deadline and does not retry requests', async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const fetchMock = vi.fn().mockImplementation((_path, init: RequestInit) => new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))));
    vi.stubGlobal('fetch', fetchMock);
    const pending = api('/api/slow', { method: 'POST', body: '{"once":true}', signal: caller.signal });
    const expectation = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    caller.abort();
    await expectation;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0][1] as RequestInit).signal).not.toBe(caller.signal);
    vi.useRealTimers();
  });

  it('applies the same deadline to apiLocal and exempts chat streams', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation((_path, init: RequestInit) => new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))));
    vi.stubGlobal('fetch', fetchMock);
    const pending = (await import('./api')).apiLocal('/api/local-slow');
    await Promise.resolve();
    await Promise.resolve();
    const expectation = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(30_000);
    await expectation;
    fetchMock.mockResolvedValueOnce(new Response());
    await fetchApi('/api/chat', { signal: new AbortController().signal });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[1][1] as RequestInit).signal).toBeDefined();
    vi.useRealTimers();
  });

  it('accepts a successful empty response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));

    await expect(api('/api/reset')).resolves.toBeUndefined();
  });

  it('dispatches the reauthentication signal for malformed 401 JSON before parsing fails', async () => {
    const event = vi.fn();
    window.addEventListener('burrow:auth-required', event);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{broken', { status: 401, headers: { 'content-type': 'application/json' } })));
    await expect(api('/api/agents')).rejects.toMatchObject({ status: 401 });
    expect(event).toHaveBeenCalledOnce();
    window.removeEventListener('burrow:auth-required', event);
  });

  it('reports malformed JSON only when JSON was promised', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{broken', { headers: { 'content-type': 'application/json' } })));

    await expect(api('/api/agents')).rejects.toMatchObject({
      message: 'invalid_json_response',
      status: 200,
      details: '{broken',
    });
  });

  it('preserves a short excerpt for non-JSON error responses', async () => {
    const responseBody = '<html>upstream failure</html>';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(responseBody, {
      status: 502,
      headers: { 'content-type': 'text/html' },
    })));

    await expect(api('/api/agents')).rejects.toMatchObject({
      message: responseBody,
      status: 502,
      details: responseBody,
    });
  });

  it('preserves a non-JSON successful response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('ready', { headers: { 'content-type': 'text/plain' } })));

    await expect(api<string>('/api/health')).resolves.toBe('ready');
  });
});
