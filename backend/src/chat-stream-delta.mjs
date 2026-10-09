// Shared by the HTTP transport and composed provider/runtime contract tests.
export function createChatStreamDelta({ record, type, runId, sessionId, write, clock = () => new Date().toISOString() }) {
  return ({ delta, totalChars, modelCall }) => {
    record.phase = 'streaming';
    write({ type, runId, sessionId, ts: clock(), data: { delta, totalChars, modelCall } });
  };
}
