// Terminal state and diagnostics are runtime-owned metadata, never assistant text.
// The backend alone projects evidenced historical wrappers into this contract.
export type ChatTerminalStatus = 'completed' | 'failed' | 'cancelled' | 'superseded';
export type ModelFailure = {
  origin: 'upstream' | 'burrow' | 'unknown' | 'cancelled';
  code: string;
  retryable: boolean;
  status?: number;
  /** Bounded, credential-redacted explanation supplied by the backend. */
  message?: string;
};
export type ModelRecovery = {
  version: 1;
  retryCount: number;
  requests: Array<{
    state:
      | 'recovering'
      | 'resumed'
      | 'exhausted'
      | 'blocked'
      | 'requires_investigation'
      | 'cancelled';
    logicalRequestId?: string;
    method?: 'complete' | 'continueWithToolResults';
    attempt?: number;
    maxAttempts?: number;
    delayMs?: number;
    retryCount?: number;
    originalFailure?: ModelFailure;
    lastFailure?: ModelFailure;
    failover?: { code: string; action: string };
    partialOutput?: { textChars?: number; thoughtChars?: number };
  }>;
};
export type ChatTerminalMetadata = {
  chatResultVersion: 2;
  terminalStatus: ChatTerminalStatus;
  modelFailure?: ModelFailure;
  modelRecovery?: ModelRecovery;
};

const statuses: ChatTerminalStatus[] = ['completed', 'failed', 'cancelled', 'superseded'];
const recoveryStates = [
  'recovering',
  'resumed',
  'exhausted',
  'blocked',
  'requires_investigation',
  'cancelled',
];
const failoverCodes = new Set([
  'provider_pool_replay_incomplete_history',
  'provider_pool_replay_nonportable_history',
  'provider_pool_replay_unavailable',
  'provider_pool_alternate_selection_failed',
  'provider_pool_alternate_resolution_failed',
  'provider_pool_continuation_owner_missing',
  'provider_pool_continuation_owner_unavailable',
  'provider_pool_signed_history_owner_missing',
]);
const origins: ModelFailure['origin'][] = ['upstream', 'burrow', 'unknown', 'cancelled'];
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const statusOf = (value: unknown): ChatTerminalStatus | undefined =>
  statuses.includes(value as ChatTerminalStatus) ? (value as ChatTerminalStatus) : undefined;

function chatFailure(value: unknown): ModelFailure | undefined {
  const failure = object(value);
  if (
    !origins.includes(failure.origin as ModelFailure['origin']) ||
    typeof failure.code !== 'string' ||
    !/^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(failure.code) ||
    typeof failure.retryable !== 'boolean'
  )
    return undefined;
  return {
    origin: failure.origin as ModelFailure['origin'],
    code: failure.code,
    retryable: failure.retryable,
    ...(failure.origin === 'upstream' &&
    typeof failure.message === 'string' &&
    failure.message.trim()
      ? { message: failure.message.trim().slice(0, 2048) }
      : {}),
    ...(Number.isInteger(failure.status) &&
    (failure.status as number) >= 100 &&
    (failure.status as number) <= 599
      ? { status: failure.status as number }
      : {}),
  };
}

export function chatTerminalMetadata(value: unknown): ChatTerminalMetadata | undefined {
  const source = object(value);
  const status = source.chatResultVersion === 2 ? statusOf(source.terminalStatus) : undefined;
  if (!status) return undefined;
  const modelFailure = chatFailure(source.modelFailure);
  // Compact backend recovery is v1 only. Project a bounded, allowlisted
  // display shape so browser cache never holds arbitrary nested error payloads.
  const recovery = object(source.modelRecovery);
  const requests = Array.isArray(recovery.requests) ? recovery.requests : [];
  const integer = (value: unknown, max: number, min = 0) =>
    Number.isSafeInteger(value) && (value as number) >= min
      ? Math.min(value as number, max)
      : undefined;
  const modelRecovery: ModelRecovery | undefined =
    recovery.version === 1 && Array.isArray(recovery.requests)
      ? {
          version: 1,
          retryCount: integer(recovery.retryCount, 1_000_000) ?? 0,
          requests: requests.slice(-32).flatMap((value) => {
            const record = object(value);
            if (!recoveryStates.includes(record.state as string)) return [];
            const originalFailure = chatFailure(record.originalFailure);
            const lastFailure = chatFailure(record.lastFailure);
            const partial = object(record.partialOutput);
            const textChars = integer(partial.textChars, 1_000_000_000);
            const thoughtChars = integer(partial.thoughtChars, 1_000_000_000);
            const failover = object(record.failover);
            return [
              {
                state: record.state as ModelRecovery['requests'][number]['state'],
                ...(typeof record.logicalRequestId === 'string' &&
                /^[A-Za-z0-9._:-]{1,128}$/.test(record.logicalRequestId)
                  ? { logicalRequestId: record.logicalRequestId }
                  : {}),
                ...(record.method === 'complete' || record.method === 'continueWithToolResults'
                  ? { method: record.method }
                  : {}),
                ...Object.fromEntries(
                  (
                    [
                      ['attempt', 1_000, 1],
                      ['maxAttempts', 1_000, 1],
                      ['delayMs', 3_600_000, 0],
                      ['retryCount', 1_000_000, 0],
                    ] as const
                  ).flatMap(([key, max, min]) => {
                    const count = integer(record[key], max, min);
                    return count === undefined ? [] : [[key, count]];
                  }),
                ),
                ...(originalFailure ? { originalFailure } : {}),
                ...(lastFailure ? { lastFailure } : {}),
                ...(typeof failover.code === 'string' &&
                failoverCodes.has(failover.code) &&
                ['blocked', 'retry', 'requires_investigation', 'cancelled'].includes(
                  failover.action as string,
                )
                  ? { failover: { code: failover.code, action: failover.action as string } }
                  : {}),
                ...(textChars !== undefined || thoughtChars !== undefined
                  ? {
                      partialOutput: {
                        ...(textChars === undefined ? {} : { textChars }),
                        ...(thoughtChars === undefined ? {} : { thoughtChars }),
                      },
                    }
                  : {}),
              },
            ];
          }),
        }
      : undefined;
  return {
    chatResultVersion: 2,
    terminalStatus: status,
    ...(modelFailure ? { modelFailure } : {}),
    ...(modelRecovery ? { modelRecovery } : {}),
  };
}

function responseParts(value: unknown) {
  const root = object(value);
  return [object(root.result), object(root.summary), root];
}

/** An event is authoritative even when its transport succeeded or metadata is missing. */
export function chatTerminalResult(value: unknown, terminalType: string): ChatTerminalMetadata {
  const parts = responseParts(value);
  const structured = parts.map(chatTerminalMetadata).find((metadata) => metadata !== undefined);
  const eventStatus = statusOf(
    terminalType.replace(/^run\./, '').replace(/^complete$/, 'completed'),
  );
  const failed = parts.some((part) => part.ok === false);
  const status =
    terminalType === 'run.completed'
      ? (structured?.terminalStatus ?? (failed ? 'failed' : 'completed'))
      : (eventStatus ?? structured?.terminalStatus ?? (failed ? 'failed' : 'completed'));
  const failure = parts.map((part) => chatTerminalMetadata(part)?.modelFailure).find(Boolean);
  const recovery = parts.map((part) => chatTerminalMetadata(part)?.modelRecovery).find(Boolean);
  return {
    chatResultVersion: 2,
    terminalStatus: status,
    ...(failure ? { modelFailure: failure } : {}),
    ...(recovery ? { modelRecovery: recovery } : {}),
  };
}

/** Only explicit answer fields count as assistant content; never stringify results/errors. */
export function chatAnswerText(value: unknown): string | undefined {
  for (const part of responseParts(value)) {
    for (const field of ['answerText', 'content']) {
      if (typeof part[field] === 'string') return part[field] as string;
      // Explicit null is an authoritative empty answer, not a missing field.
      if (part[field] === null) return '';
    }
  }
  return undefined;
}

const runtimeLabels: Record<string, string> = {
  context_compression_failed: 'Conversation compaction failed.',
  context_compression_unavailable: 'Conversation compaction is unavailable.',
  context_preparation_prompt_over_budget:
    'The prepared conversation still exceeds the model’s context budget.',
  context_preparation_uncovered_history:
    'Conversation preparation could not safely include all required history.',
  CONTEXT_BOUNDARY_VIOLATION: 'Conversation context failed a runtime boundary check.',
};

const labels: Record<string, string> = {
  provider_rate_limited: 'The model provider is rate limiting requests.',
  provider_unavailable: 'The model provider is temporarily unavailable.',
  provider_stream_truncated: 'The model provider stream ended early.',
  provider_read_failed: 'The model provider connection was interrupted.',
  provider_transport_failed: 'The model provider connection failed.',
  provider_generation_failed: 'The model provider could not complete this response.',
  model_result_invalid: 'The runtime received an invalid model result.',
  model_configuration_invalid: 'The model configuration is invalid.',
  model_request_invalid: 'The model request is invalid.',
  model_response_budget_exhausted: 'The model response budget was exhausted.',
  model_cancelled: 'The run was cancelled.',
  model_failure_unknown: 'The run could not be completed.',
};

export function chatTerminalDiagnostic(metadata: ChatTerminalMetadata): {
  message: string;
  overloaded: boolean;
  upstream: boolean;
} {
  const { terminalStatus: status, modelFailure: failure } = metadata;
  if (status === 'cancelled')
    return { message: 'The run was cancelled.', overloaded: false, upstream: false };
  if (status === 'superseded')
    return { message: 'A newer run replaced this one.', overloaded: false, upstream: false };
  const upstream = failure?.origin === 'upstream';
  const overloaded =
    upstream &&
    (failure.code === 'provider_rate_limited' ||
      failure.code === 'provider_unavailable' ||
      (failure.code === `provider_http_${failure.status}` &&
        (failure.status === 429 || failure.status === 503)));
  const message =
    failure?.origin === 'burrow' && Object.hasOwn(runtimeLabels, failure.code)
      ? `${runtimeLabels[failure.code]} (code: ${failure.code})`
      : upstream && failure.message?.trim()
        ? failure.message
        : upstream && failure.status && failure.code === `provider_http_${failure.status}`
          ? failure.status === 429
            ? 'The model provider is rate limiting requests (HTTP 429).'
            : failure.status === 503
              ? 'The model provider is temporarily unavailable (HTTP 503).'
              : `The model provider returned HTTP ${failure.status}.`
          : failure &&
              (failure.origin === 'upstream' || !failure.code.startsWith('provider_')) &&
              labels[failure.code]
            ? labels[failure.code]
            : failure
              ? `${upstream ? 'The model provider' : failure.origin === 'burrow' ? 'The runtime' : 'The run'} could not complete this response (code: ${failure.code}).`
              : 'The run could not be completed.';
  return { message, overloaded, upstream };
}

/** Copy only the projected terminal contract, never raw errors or response envelopes. */
export function chatTerminalCopy(metadata: ChatTerminalMetadata): string {
  const terminal = chatTerminalMetadata(metadata);
  if (!terminal || terminal.terminalStatus === 'completed') return '';
  const failure = terminal.modelFailure;
  const recovery = terminal.modelRecovery;
  const failureDetail = (label: string, value: ModelFailure) =>
    `${label}: ${value.code}${value.status ? ` (HTTP ${value.status})` : ''}${value.message ? ` — ${value.message}` : ''}`;
  return [
    chatTerminalDiagnostic(terminal).message,
    `Run status: ${terminal.terminalStatus}`,
    ...(failure
      ? [
          `Origin: ${failure.origin}`,
          `Code: ${failure.code}`,
          ...(failure.status ? [`HTTP status: ${failure.status}`] : []),
          `Retryable: ${failure.retryable ? 'yes' : 'no'}`,
        ]
      : []),
    ...(recovery
      ? [
          `Recovery retries: ${recovery.retryCount}`,
          ...recovery.requests.map((request, index) =>
            [
              `Recovery ${index + 1}: ${request.state}`,
              ...(request.attempt !== undefined
                ? [
                    `Attempt: ${request.attempt}${request.maxAttempts !== undefined ? `/${request.maxAttempts}` : ''}`,
                  ]
                : []),
              ...(request.delayMs !== undefined ? [`Delay: ${request.delayMs} ms`] : []),
              ...(request.retryCount !== undefined ? [`Retries: ${request.retryCount}`] : []),
              ...(request.originalFailure
                ? [failureDetail('Original failure', request.originalFailure)]
                : []),
              ...(request.lastFailure ? [failureDetail('Last failure', request.lastFailure)] : []),
              ...(request.failover
                ? [`Failover: ${request.failover.code} (${request.failover.action})`]
                : []),
            ].join('\n'),
          ),
        ]
      : []),
  ].join('\n');
}
