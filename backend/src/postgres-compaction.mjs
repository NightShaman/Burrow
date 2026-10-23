// Match the earliest unused occurrence satisfying the legacy compaction identity
// rules. Queues avoid rescanning/stringifying the transcript for every tail row.
export function matchCompactionOccurrences(rows, entries, sessionId) {
  const sequences = new Map(), ids = new Map(), payloads = new Map();
  const add = (map, key, index) => {
    let queue = map.get(key);
    if (!queue) map.set(key, queue = { indices: [], next: 0 });
    // Exact and normalized payloads can be identical.
    if (queue.indices.at(-1) !== index) queue.indices.push(index);
  };
  rows.forEach((row, index) => {
    add(sequences, String(row.sequence), index);
    if (row.entry?.id) add(ids, row.entry.id, index);
    add(payloads, JSON.stringify(row.entry), index);
    add(payloads, JSON.stringify({ ...row.entry, sessionId, metadata: { ...(row.entry.metadata || {}) } }), index);
  });
  const used = new Set();
  const peek = queue => {
    if (!queue) return Infinity;
    while (queue.next < queue.indices.length && used.has(queue.indices[queue.next])) queue.next++;
    return queue.indices[queue.next] ?? Infinity;
  };
  return entries.map(entry => {
    const index = Math.min(
      peek(entry.sequence ? sequences.get(String(entry.sequence)) : null),
      peek(entry.id ? ids.get(entry.id) : null),
      peek(payloads.get(JSON.stringify(entry))),
    );
    if (index === Infinity) return null;
    used.add(index);
    return rows[index];
  });
}

// Bound SQL parameters and server work per copy without changing the enclosing
// transaction/session-lock boundary. Payload bytes never make the JS round trip.
export const COMPACTION_COPY_BATCH_SIZE = 256;
