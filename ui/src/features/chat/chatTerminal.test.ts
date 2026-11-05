import { describe, expect, it } from 'vitest';
import {
  chatAnswerText,
  chatTerminalCopy,
  chatTerminalDiagnostic,
  chatTerminalMetadata,
  chatTerminalResult,
} from './chatTerminal';

const rateLimit = {
  origin: 'upstream' as const,
  code: 'provider_http_429',
  retryable: true,
  status: 429,
};
const recovery = {
  version: 1 as const,
  retryCount: 1,
  requests: [{ state: 'exhausted' as const }],
};

describe('structured terminal contract', () => {
  it.each(['result', 'summary', 'root'] as const)(
    'reads %s v2 metadata independent of transport',
    (place) => {
      const terminal = {
        chatResultVersion: 2,
        terminalStatus: 'failed',
        modelFailure: rateLimit,
        modelRecovery: recovery,
      };
      const envelope = place === 'root' ? terminal : { [place]: terminal, ok: true };
      expect(chatTerminalResult(envelope, 'run.completed')).toEqual(terminal);
      expect(chatTerminalResult(envelope, 'run.failed')).toEqual(terminal);
    },
  );
  it.each(['failed', 'cancelled', 'superseded'] as const)(
    'classifies an unversioned %s terminal event',
    (status) => {
      expect(chatTerminalResult({ ok: false, error: 'provider-secret' }, `run.${status}`)).toEqual({
        chatResultVersion: 2,
        terminalStatus: status,
      });
    },
  );
  it('takes explicit terminal fields even when HTTP succeeded and excludes diagnostic prose', () => {
    expect(
      chatTerminalResult(
        { ok: false, result: { chatResultVersion: 2, terminalStatus: 'cancelled' } },
        '',
      )?.terminalStatus,
    ).toBe('cancelled');
    expect(
      chatAnswerText({
        ok: false,
        result: { answerText: 'Last genuine partial', error: 'private' },
      }),
    ).toBe('Last genuine partial');
    expect(
      chatAnswerText({ ok: false, error: 'private', blockers: ['no answer'] }),
    ).toBeUndefined();
    expect(chatAnswerText({ ok: true, result: {} })).toBeUndefined();
    expect(chatAnswerText({ result: { answerText: '[model_error: literal response]' } })).toBe(
      '[model_error: literal response]',
    );
  });
  it.each(['', null])(
    'preserves an explicit %s answer over root or summary fallbacks',
    (answerText) => {
      expect(
        chatAnswerText({
          result: { answerText },
          summary: { answerText: 'summary draft' },
          answerText: 'root draft',
        }),
      ).toBe('');
      expect(chatAnswerText({ result: { content: answerText }, content: 'root draft' })).toBe('');
    },
  );
  it('does not infer failure from unversioned content and accepts projected legacy metadata only', () => {
    expect(
      chatTerminalMetadata({ decision: 'model_failed', content: '[model_error: old]' }),
    ).toBeUndefined();
    expect(
      chatTerminalMetadata({
        chatResultVersion: 2,
        terminalStatus: 'failed',
        modelFailure: { origin: 'unknown', code: 'model_failure_unknown', retryable: false },
      })?.terminalStatus,
    ).toBe('failed');
  });
  it('derives safe diagnostics from structured origin/code/status (not wording)', () => {
    const terminal = (
      modelFailure:
        | typeof rateLimit
        | { origin: 'burrow'; code: string; retryable: false }
        | { origin: 'upstream'; code: string; retryable: false; status?: number },
    ) => ({ chatResultVersion: 2 as const, terminalStatus: 'failed' as const, modelFailure });
    expect(chatTerminalDiagnostic(terminal(rateLimit))).toMatchObject({
      overloaded: true,
      upstream: true,
      message: expect.stringContaining('429'),
    });
    expect(
      chatTerminalDiagnostic(
        terminal({ origin: 'upstream', code: 'provider_http_400', retryable: false, status: 400 }),
      ).overloaded,
    ).toBe(false);
    expect(
      chatTerminalDiagnostic(
        terminal({ origin: 'burrow', code: 'request_failed', retryable: false }),
      ).upstream,
    ).toBe(false);
    expect(
      chatTerminalDiagnostic(
        terminal({ origin: 'burrow', code: 'rate_limit_unavailable', retryable: false }),
      ).overloaded,
    ).toBe(false);
    expect(
      chatTerminalDiagnostic(
        terminal({ origin: 'burrow', code: 'provider_rate_limited', retryable: false }),
      ).message,
    ).toContain('The runtime');
  });
});

it('bounds recovery records, numeric fields and nested failures without preserving opaque data', () => {
  const metadata = chatTerminalMetadata({
    chatResultVersion: 2,
    terminalStatus: 'failed',
    modelRecovery: {
      version: 1,
      retryCount: 2,
      requests: [
        {
          state: 'exhausted',
          attempt: 100000,
          originalFailure: {
            origin: 'upstream',
            code: 'provider_http_429',
            status: 429,
            retryable: true,
            secret: 'private',
          },
          privateMessage: 'secret',
        },
      ],
      privateMessage: 'secret',
    },
  });
  expect(metadata?.modelRecovery).toEqual({
    version: 1,
    retryCount: 2,
    requests: [
      {
        state: 'exhausted',
        attempt: 1000,
        originalFailure: rateLimit,
      },
    ],
  });
});

it.each(['result', 'summary', 'root'] as const)(
  'preserves explicit provider prose in %s without changing classification',
  (place) => {
    const metadata = {
      chatResultVersion: 2 as const,
      terminalStatus: 'failed' as const,
      modelFailure: { ...rateLimit, message: 'The usage limit has been reached' },
    };
    const parsed = chatTerminalResult(
      place === 'root' ? metadata : { [place]: metadata },
      'run.failed',
    );
    expect(parsed).toEqual(metadata);
    expect(chatTerminalDiagnostic(parsed)).toEqual({
      message: 'The usage limit has been reached',
      overloaded: true,
      upstream: true,
    });
  },
);

it.each([undefined, '', '   ', { message: 'opaque' }, ['opaque'], 429])(
  'uses generic fallback for unusable provider message %s',
  (message) => {
    const terminal = chatTerminalMetadata({
      chatResultVersion: 2,
      terminalStatus: 'failed',
      modelFailure: { ...rateLimit, message },
      error: { arbitrary: 'private' },
    })!;
    expect(terminal.modelFailure?.message).toBeUndefined();
    expect(chatTerminalDiagnostic(terminal).message).toContain('HTTP 429');
  },
);

it('bounds prose at the contract boundary and does not label local wording as provider text', () => {
  const terminal = chatTerminalMetadata({
    chatResultVersion: 2,
    terminalStatus: 'failed',
    modelFailure: { ...rateLimit, message: 'x'.repeat(9000), raw: 'private' },
  })!;
  expect(terminal.modelFailure?.message).toHaveLength(2048);
  expect(JSON.stringify(terminal)).not.toContain('private');
  expect(
    chatTerminalDiagnostic({
      ...terminal,
      modelFailure: {
        origin: 'burrow',
        code: 'model_result_invalid',
        retryable: false,
        message: 'Provider sounding prose',
      },
    }),
  ).toMatchObject({ upstream: false, message: 'The runtime received an invalid model result.' });
});

it('copies useful projected diagnostics and recovery without arbitrary errors', () => {
  const terminal = chatTerminalMetadata({
    chatResultVersion: 2,
    terminalStatus: 'failed',
    modelFailure: { ...rateLimit, message: 'The usage limit has been reached' },
    error: { secret: 'private' },
    modelRecovery: {
      version: 1,
      retryCount: 2,
      requests: [
        {
          state: 'blocked',
          attempt: 3,
          maxAttempts: 3,
          delayMs: 1000,
          lastFailure: { ...rateLimit, message: 'Retry after reset' },
          failover: { code: 'provider_pool_alternate_selection_failed', action: 'blocked' },
          arbitrary: 'private',
        },
      ],
    },
  })!;
  const copied = chatTerminalCopy(terminal);
  for (const detail of [
    'The usage limit has been reached',
    'Run status: failed',
    'Origin: upstream',
    'Code: provider_http_429',
    'HTTP status: 429',
    'Retryable: yes',
    'Recovery retries: 2',
    'Recovery 1: blocked',
    'Attempt: 3/3',
    'Delay: 1000 ms',
    'Retry after reset',
    'provider_pool_alternate_selection_failed',
  ])
    expect(copied).toContain(detail);
  expect(copied).not.toContain('private');
});
