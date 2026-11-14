// Request-local attestation: only the canonical budget projector may replace an
// exact transcript with a compacted/steered one. Snapshot values so mutation
// after preparation cannot authorize a different replay.
const replayPreparations = new WeakMap();
const replaySource = ({ baseMessages, toolCalls, toolResults }) => JSON.stringify({ baseMessages, toolCalls, toolResults });
export function isPreparedPoolReplay(messages, source) {
  const proof = replayPreparations.get(messages);
  return Boolean(proof && proof.source === replaySource(source) && proof.messages === JSON.stringify(messages));
}
export function attestPreparation(result, source) {
  replayPreparations.set(result.messages, { source: replaySource(source), messages: JSON.stringify(result.messages) });
  return result;
}
