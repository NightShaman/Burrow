import { mergeReadEvidence } from './read-evidence.mjs';

export async function writeSessionReadEvidence({ sessionId, evidence = [], conversationStore, agentId } = {}) {
  if (!conversationStore) throw new Error('conversation_store_required');
  const retained = mergeReadEvidence(evidence, []);
  await conversationStore.patchMetadata({agentId,sessionId,metadata:{readEvidence:retained}});
  return retained;
}

export async function readSessionReadEvidence({ sessionId, conversationStore, agentId } = {}) {
  if (!conversationStore) throw new Error('conversation_store_required');
  return (await conversationStore.getMetadata({agentId,sessionId}))?.readEvidence || [];
}
