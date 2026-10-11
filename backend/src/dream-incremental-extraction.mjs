import { createHash } from 'node:crypto';

// Bump whenever the extraction prompt, normalization, or citation contract changes.
export const DREAM_EXTRACTION_CONTRACT_VERSION = 'dream-raw-v3-synthesis-evidence';
export function dreamSourceIdentity(message) {
  return createHash('sha256').update(JSON.stringify([message.sourceRef, message.sessionId, message.entryId, message.role, message.at, message.content])).digest('hex');
}

/** Validate against the current maximum eligible window, not cached source text.
 * Invalidate a complete batch when any contributing source changes/disappears:
 * candidates may depend on uncited context, so ref-only invalidation is unsafe. */
export async function prepareDreamExtraction({ store, agentId, messages, contractVersion = DREAM_EXTRACTION_CONTRACT_VERSION }) {
  const identities = new Map(messages.map(message => [message.sourceRef, dreamSourceIdentity(message)]));
  const covered = new Set();
  const candidates = { memories: [], preferences: [] };
  const stale = [];
  for (const batch of await store.list({ agentId })) {
    if (batch.contractVersion !== contractVersion || !batch.sources.length || batch.sources.some(source => identities.get(source.sourceRef) !== source.identity)) {
      stale.push(batch.batchId); continue;
    }
    for (const source of batch.sources) covered.add(source.sourceRef);
    for (const key of ['memories', 'preferences']) candidates[key].push(...batch.candidates[key]);
  }
  await store.remove({ agentId, batchIds: stale });
  return { candidates, covered, contractVersion };
}

export function candidatesInDreamWindow(candidates, messages) {
  const refs = new Set(messages.map(message => message.sourceRef));
  // Do not strip citations from a multi-source claim: that could leave unsupported
  // content. A claim enters a narrower window only with ALL its evidence.
  return Object.fromEntries(['memories', 'preferences'].map(key => [key, candidates[key].filter(candidate => candidate.sourceRefs.length && candidate.sourceRefs.every(ref => refs.has(ref)))]));
}

export async function extractIncrementalDreamCandidates({ store, agentId, state, messages, generatedAt, extract, onProgress }) {
  const uncovered = messages.filter(message => !state.covered.has(message.sourceRef));
  const reusedCoverage = messages.length - uncovered.length;
  let newCoverage = 0;
  // Partition before prompt budgeting: chunks may split the content of a single
  // sourceRef. Only the completed UTC day is an atomic unit of coverage.
  const days = new Map();
  for (const message of uncovered) {
    const day = message.at.slice(0, 10);
    if (!days.has(day)) days.set(day, []);
    days.get(day).push(message);
  }
  await onProgress?.({ reusedCoverage, newCoverage, extractionMessages: uncovered.length });
  const result = { chunks: 0, diagnostics: [] };
  try {
    for (const day of [...days.keys()].sort()) {
      const originals = days.get(day);
      const raw = { memories: [], preferences: [] };
      const extracted = await extract(originals, async ({ candidates }) => {
        for (const key of ['memories', 'preferences']) raw[key].push(...candidates[key]);
      });
      await store.checkpoint({ agentId, contractVersion: state.contractVersion,
        sources: originals.map(message => ({ sourceRef: message.sourceRef, identity: dreamSourceIdentity(message), at: message.at })),
        candidates: raw, completedAt: generatedAt });
      for (const message of originals) state.covered.add(message.sourceRef);
      for (const key of ['memories', 'preferences']) state.candidates[key].push(...raw[key]);
      newCoverage += originals.length;
      result.chunks += extracted.chunks || 0;
      result.diagnostics.push(...(extracted.diagnostics || []));
      await onProgress?.({ reusedCoverage, newCoverage, extractionMessages: uncovered.length });
    }
    return { ...result, ...candidatesInDreamWindow(state.candidates, messages), reusedCoverage, newCoverage, extractionMessages: uncovered.length };
  } catch (error) {
    error.coverage = { reusedCoverage, newCoverage, extractionMessages: uncovered.length };
    error.completedChunks = result.chunks + (error.completedChunks || 0);
    error.diagnostics = [...result.diagnostics, ...(error.diagnostics || [])];
    throw error;
  }
}
