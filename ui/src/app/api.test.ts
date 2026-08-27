import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, apiForTarget, apiUrl, fetchApi, setActiveApiTarget } from './api';
import { localApiTarget } from './apiTargets';
import { clearBasicCredentials, setBasicCredentials } from './auth';

describe('API requests', () => {
  afterEach(() => {
    setActiveApiTarget(undefined);
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

  it('keeps local API paths relative and routes remote paths to their owner', async () => {
    expect(apiUrl(localApiTarget, '/api/agents')).toBe('/api/agents');
    expect(apiUrl({ baseUrl: 'http://node.example:8787/' }, '/api/agents')).toBe('http://node.example:8787/api/agents');

    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ agents: [] }), { headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    setBasicCredentials('goblin', 'secret');
    await apiForTarget({ baseUrl: 'http://node.example:8787' }, '/api/agents');
    expect(fetchMock).toHaveBeenCalledWith('http://node.example:8787/api/agents', expect.any(Object));
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).has('authorization')).toBe(false);
  });

  it('keeps an explicit local target local when the active target is remote', async () => {
    setActiveApiTarget({ id: 'remote', name: 'Remote', baseUrl: 'http://node.example:8787', enabled: true });
    setBasicCredentials('goblin', 'secret');
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ agents: [] }), { headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await apiForTarget(localApiTarget, '/api/agents');

    expect(fetchMock).toHaveBeenCalledWith('/api/agents', expect.any(Object));
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).get('authorization')).toBe('Basic Z29ibGluOnNlY3JldA==');
  });

  it('accepts a successful empty response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));

    await expect(api('/api/reset')).resolves.toBeUndefined();
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
