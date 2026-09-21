import type { ProgressEntry, RunProgress } from '../../app/api';

type ThoughtEvent = {
  type?: string;
  ts?: unknown;
  data?: { delta?: unknown; modelCall?: unknown };
};

function thoughtModelCall(value: unknown) {
  const modelCall = Number(value);
  return Number.isFinite(modelCall) ? modelCall : undefined;
}

function exactComparableText(value: string) {
  return value.trim().replace(/\s+/g, ' ');
}

export function appendThoughtDelta(entries: ProgressEntry[], event: ThoughtEvent, runId: string): ProgressEntry[] {
  if (event.type !== 'assistant.thought' || typeof event.data?.delta !== 'string') return entries;
  const modelCall = thoughtModelCall(event.data.modelCall);
  const previous = entries.at(-1);
  if (previous && previous.modelCall === modelCall) {
    return [...entries.slice(0, -1), { ...previous, text: `${previous.text}${event.data.delta}` }];
  }
  return [...entries, {
    id: `${runId}:thought:${entries.length + 1}`,
    text: event.data.delta,
    ts: typeof event.ts === 'string' ? event.ts : new Date().toISOString(),
    ...(modelCall === undefined ? {} : { modelCall }),
    status: 'streaming',
  }];
}

export function thoughtProgressFromEvents(events: ThoughtEvent[], runId: string): ProgressEntry[] {
  return events.reduce<ProgressEntry[]>((entries, event) => appendThoughtDelta(entries, event, runId), []);
}

/**
 * Finalize transient provider thought rows without provider-specific rules.
 * A row is omitted only when its complete normalized text exactly matches the
 * durable answer; partial/fuzzy overlap is intentionally retained.
 */
export function finalizeThoughtProgress(
  entries: ProgressEntry[],
  status: NonNullable<RunProgress['status']>,
  finalAnswer: string,
): RunProgress | undefined {
  const answer = exactComparableText(finalAnswer);
  const retained = entries.filter((entry) => !answer || exactComparableText(String(entry.text ?? '')) !== answer);
  if (!retained.length) return undefined;
  return {
    status,
    items: retained.map((entry) => ({ ...entry, status: status === 'complete' ? 'complete' : 'streaming' })),
  };
}
