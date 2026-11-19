import { fetchApi, parseApiResponse } from '../../app/api';
import { chatTerminalResult } from './chatTerminal';

export type ChatStreamResult = {
  terminalType: string;
  finalResult: unknown;
};

type ChatStreamOptions = {
  requestBody: unknown;
  signal: AbortSignal;
  owner?: { runId: string; sessionId: string };
  onEvent: (event: unknown) => void;
  onAccepted?: () => void;
};

export async function streamChat({
  requestBody,
  signal,
  owner,
  onEvent,
  onAccepted,
}: ChatStreamOptions): Promise<ChatStreamResult> {
  const response = await fetchApi('/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' },
    body: JSON.stringify(requestBody),
    signal,
  });

  if (!response.ok) {
    // Use the same backend error contract as non-streaming API calls.
    // A rejected submission still has a diagnostic, but no assistant turn.
    await parseApiResponse(response);
    throw new Error(`HTTP ${response.status}`);
  }

  onAccepted?.();
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/x-ndjson') || !response.body) {
    const finalResult: unknown = await response.json();
    const status = chatTerminalResult(finalResult, '').terminalStatus;
    return { terminalType: `run.${status === 'completed' ? 'completed' : status}`, finalResult };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let terminalType = '';
  let finalResult: unknown = null;
  const handleLine = (line: string) => {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      throw new Error('The streaming response was malformed.');
    }
    if (!event || typeof event !== 'object') return;
    const envelope = event as {
      type?: unknown;
      runId?: unknown;
      sessionId?: unknown;
      data?: { response?: unknown };
    };
    if (
      owner &&
      ((envelope.runId !== undefined && envelope.runId !== owner.runId) ||
        (envelope.sessionId !== undefined && envelope.sessionId !== owner.sessionId))
    )
      return;
    onEvent(event);
    if (
      envelope.type === 'run.completed' ||
      envelope.type === 'run.failed' ||
      envelope.type === 'run.cancelled' ||
      envelope.type === 'run.superseded'
    ) {
      terminalType = envelope.type;
      finalResult = envelope.data?.response ?? null;
    }
  };

  let eof = false;
  try {
    while (!eof && !terminalType) {
      const { value, done } = await reader.read();
      eof = done;
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim()) handleLine(line);
        if (terminalType) break;
      }
    }
    if (!terminalType && buffer.trim()) handleLine(buffer);
    if (!terminalType) throw new Error('The stream ended without a terminal event.');
    return { terminalType, finalResult };
  } finally {
    // A terminal envelope or faulty parser can end the run before transport EOF.
    if (!eof) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
