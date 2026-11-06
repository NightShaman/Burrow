import { secureUuid } from '../../app/secureUuid';

// Survives hook navigation/remount, but never a confirmed acceptance. The signature
// includes the complete operation payload (including server generation or run ID).
const ambiguous = new Map<string, string>();
const MAX_AMBIGUOUS = 256;

export function chatInputRetryKey(operation: 'input' | 'steer', payload: unknown) {
  const signature = JSON.stringify([operation, payload]);
  let key = ambiguous.get(signature);
  if (!key) {
    key = secureUuid();
    if (ambiguous.size >= MAX_AMBIGUOUS) ambiguous.delete(ambiguous.keys().next().value!);
    ambiguous.set(signature, key);
  }
  return { signature, key };
}

export function acknowledgeChatInputRetry(signature: string, key: string) {
  // An older in-flight acknowledgement must not erase a newer operation's key.
  if (ambiguous.get(signature) === key) ambiguous.delete(signature);
}
