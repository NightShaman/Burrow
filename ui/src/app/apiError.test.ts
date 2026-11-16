import { describe, expect, it } from 'vitest';
import { apiErrorMessage } from './apiError';
import { parseApiResponse } from './api';

describe('API diagnostics presentation', () => {
  it('retains API reason/code/status without dumping details', async () => {
    let failure: unknown;
    try {
      await parseApiResponse(
        new Response(
          JSON.stringify({
            ok: false,
            error: {
              code: 'storage_unavailable',
              message: 'Gallery database is offline.',
              details: 'private configuration',
            },
          }),
          { status: 503, headers: { 'content-type': 'application/json' } },
        ),
      );
    } catch (cause) {
      failure = cause;
    }
    expect(apiErrorMessage(failure, 'Could not load.')).toBe(
      'Could not load. Gallery database is offline. (storage_unavailable; HTTP 503)',
    );
  });
  it('uses a meaningful fallback for unknown failures', () => {
    expect(apiErrorMessage(null, 'Could not save.')).toBe('Could not save.');
    expect(apiErrorMessage(new Error(''), 'Could not save.')).toBe('Could not save.');
  });
  it('redacts recognizable credentials without discarding the reason', () => {
    const error = new Error(
      'Collector rejected Authorization=Bearer top-secret at https://user:password@collector.test; token=another-secret',
    );
    const message = apiErrorMessage(error, 'Could not save.');
    expect(message).toContain('Collector rejected Authorization=[redacted]');
    expect(message).toContain('https://[redacted]@collector.test');
    expect(message).not.toContain('top-secret');
    expect(message).not.toContain('another-secret');
  });
});
