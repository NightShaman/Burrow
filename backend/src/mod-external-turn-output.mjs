import { resolveAttachmentArtifact } from './attachment-store.mjs';
import { resolveGeneratedArtifact } from './generated-artifact-store.mjs';
import { readArtifactBytesBounded } from './artifact-bytes.mjs';

export const EXTERNAL_TURN_ATTACHMENT_MAX_BYTES = 32 * 1024 * 1024;

async function resolveOutput(agentWorkspaceRoot, id) {
  if (id.startsWith('artifacts/attachments/')) return resolveAttachmentArtifact({ agentWorkspaceRoot, artifactPath: id });
  if (id.startsWith('artifacts/generated/')) return resolveGeneratedArtifact({ agentWorkspaceRoot, storageReference: id });
  return null;
}

// Never diff a session tail: another admitted turn may already be writing there.
// The source reader includes live + compacted/reset originals for this run only.
export async function externalTurnOutputAttachments({ conversations, agentWorkspaceRoot, agentId, sessionId, runId }) {
  if (!conversations?.readArchiveRunSources) return [];
  const [source] = await conversations.readArchiveRunSources({ agentId, runs: [{ sessionId, runId }] });
  const descriptors = new Map();
  for (const entry of source?.entries || []) {
    if (entry.role !== 'assistant' || entry.type !== 'message' || entry.runId !== runId) continue;
    for (const item of [...(entry.metadata?.attachments || []), ...(entry.metadata?.outputArtifacts || [])]) {
      const id = item.artifactPath || item.storageReference;
      if (typeof id !== 'string' || descriptors.has(id)) continue;
      const resolved = await resolveOutput(agentWorkspaceRoot, id);
      if (!resolved) continue;
      descriptors.set(id, { id, name: String(item.name || resolved.name || 'attachment'), mimeType: String(item.mimeType || item.type || 'application/octet-stream'), sizeBytes: resolved.stat.size });
    }
  }
  return [...descriptors.values()];
}

export async function readExternalTurnOutputAttachment({ agentWorkspaceRoot, descriptor }) {
  const resolved = await resolveOutput(agentWorkspaceRoot, descriptor.id);
  if (!resolved) return null;
  if (resolved.stat.size > EXTERNAL_TURN_ATTACHMENT_MAX_BYTES) throw new Error('mod_external_turn_attachment_too_large');
  const bytes = await readArtifactBytesBounded(resolved.filePath, EXTERNAL_TURN_ATTACHMENT_MAX_BYTES);
  if (!bytes || bytes.length !== descriptor.sizeBytes) return null;
  return { name: descriptor.name, mimeType: descriptor.mimeType, sizeBytes: bytes.length, encoding: 'base64', content: bytes.toString('base64') };
}
