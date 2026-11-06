import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearBasicCredentials,
  discoverAuthMode,
  getBasicAuthHeader,
  validateBasicCredentials,
} from './auth';

afterEach(() => {
  vi.restoreAllMocks();
  clearBasicCredentials();
});

describe('R03 auth contract', () => {
  it('discovers effective auth mode before boot', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: true, auth: { mode: 'none', enabled: false } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    await expect(discoverAuthMode()).resolves.toEqual({ mode: 'none' });
    expect(fetch).toHaveBeenCalledWith(
      '/api/auth/discovery',
      expect.objectContaining({ headers: { accept: 'application/json' } }),
    );
  });
  it.each(['none', 'basic'] as const)('accepts backend nested discovery %s', async (mode) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: true, auth: { mode, enabled: mode === 'basic' } }), {
          status: 200,
        }),
      ),
    );
    await expect(discoverAuthMode()).resolves.toEqual({ mode });
  });
  it.each([{}, { mode: 'basic' }, { auth: { mode: 'unknown' } }])(
    'rejects invalid discovery body %#',
    async (body) => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 })),
      );
      await expect(discoverAuthMode()).rejects.toThrow('auth_discovery_failed');
    },
  );
  it('rejects a native Basic challenge during discovery', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('', {
          status: 401,
          headers: { 'www-authenticate': 'Basic realm="Burrow"' },
        }),
      ),
    );
    await expect(discoverAuthMode()).rejects.toThrow('auth_discovery_failed');
  });
  it('validates Basic credentials before storing them', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(validateBasicCredentials('rob', 'secret')).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/auth/validate',
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: expect.stringMatching(/^Basic /) }),
      }),
    );
    expect(getBasicAuthHeader()).toBeUndefined();
  });
  it('rejects invalid credentials', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 401 })));
    await expect(validateBasicCredentials('rob', 'wrong')).rejects.toThrow('invalid_credentials');
  });
});
