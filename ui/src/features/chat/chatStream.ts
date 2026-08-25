import { answerFromChatResult, fetchApiForTarget } from '../../app/api';
import type { ApiTarget } from '../../app/apiTargets';

export type ChatStreamResult = {
  terminalType: string;
  finalResult: unknown;
};

type ChatStreamOptions = {
  target?: ApiTarget;
  requestBody: unknown;
  signal: AbortSignal;
  onEvent: (event: unknown) => void;
};

export async function streamChat({ target, requestBody, signal, onEvent }: ChatStreamOptions): Promise<ChatStreamResult> {
  const response = await fetchApiForTarget(target, '/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' },
    body: JSON.stringify(requestBody),
    signal,
  });

  if (!response.ok) {
    const result = await response.json().catch(() => null);
    throw new Error(result ? answerFromChatResult(result) : `HTTP ${response.status}`);
  }

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/x-ndjson') || !response.body) {
    return { terminalType: 'run.completed', finalResult: await response.json() };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let terminalType = '';
  let finalResult: unknown = null;
  const handleLine = (line: string) => {
    let event: unknown;
    try { event = JSON.parse(line); }
    catch { throw new Error('The streaming response was malformed.'); }
    onEvent(event);
    if (!event || typeof event !== 'object') return;
    const envelope = event as { type?: unknown; data?: { response?: unknown } };
    if (envelope.type === 'run.completed' || envelope.type === 'run.failed' || envelope.type === 'run.cancelled' || envelope.type === 'run.superseded') {
      terminalType = envelope.type;
      finalResult = envelope.data?.response ?? null;
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) if (line.trim()) handleLine(line);
    if (done) break;
  }
  if (buffer.trim()) handleLine(buffer);
  if (!terminalType) throw new Error('The stream ended without a terminal event.');
  return { terminalType, finalResult };
}
