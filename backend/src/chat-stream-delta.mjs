// Shared by the HTTP transport and composed provider/runtime contract tests.
export function createChatStreamDelta({ record, type, runId, sessionId, write, clock = () => new Date().toISOString() }) {
  return ({ delta, totalChars, modelCall }) => {
    record.phase = 'streaming';
    // Reconnection uses the same active-run snapshot as externally dispatched
    // tasks. Keep public answer text, not private thought/provider payloads.
    if (type === 'assistant.delta') {
      if (record.answerModelCall !== modelCall) {
        record.answerModelCall = modelCall;
        record.answerText = '';
      }
      record.answerText = (record.answerText || '') + String(delta || '');
    }
    write({ type, runId, sessionId, ts: clock(), data: { delta, totalChars, modelCall } });
  };
}
