import { contextUsageFromRequest } from './model-adapters/adapter-primitives.mjs';

// Dispatch snapshots are the provider-visible input for a historical user turn,
// including its support pack. Both retention and compression must charge that
// input, not just the (often tiny) chat text. Originals remain archival evidence.
export function providerTurnsFromTranscript(entries = []) {
  const turns = new Map();
  for (const entry of entries) {
    if (entry?.type !== 'provider_history' || !entry.runId) continue;
    try {
      const snapshot = JSON.parse(entry.content);
      if (snapshot?.version === 1 && Array.isArray(snapshot.messages)
        && snapshot.messages.length <= 2 && snapshot.messages.length > 0
        && snapshot.messages.every(message => message.role === 'user')
        && (typeof snapshot.messages.at(-1).content === 'string' || Array.isArray(snapshot.messages.at(-1).content))) {
        // First dispatch wins; a retry cannot rewrite historical input.
        if (!turns.has(entry.runId)) turns.set(entry.runId, snapshot);
      }
    } catch { /* Malformed diagnostics are not replayable input. */ }
  }
  return turns;
}

export function providerTurnForEntry(entry, turns) {
  return entry?.metadata?.providerTurn || (['user', 'agent'].includes(entry?.role) ? turns.get(entry.runId) : null);
}

export function providerTurnChars(snapshot) {
  let promptChars = 0;
  let imageCount = 0;
  for (const entry of snapshot.messages || []) {
    if (typeof entry.content === 'string') promptChars += entry.content.length;
    else for (const part of Array.isArray(entry.content) ? entry.content : []) {
      promptChars += String(part?.text || '').length;
      if (part?.type === 'image_url' || part?.type === 'input_image' || part?.image_url || part?.input_image) imageCount++;
    }
  }
  // Base64 wire bytes are not text tokens. Use the provider image estimate.
  return contextUsageFromRequest({ promptChars, imageCount }).estimatedTokens * 4;
}
