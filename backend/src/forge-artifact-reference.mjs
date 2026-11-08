import { constants as fsConstants, promises as fs } from 'node:fs';
import { MODEL_VISIBLE_IMAGE_TYPES } from './attachment-store.mjs';
import { forgeStore } from './forge-agent-tools.mjs';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const REFERENCE = new RegExp(`^\\[?forge:(${UUID}):(${UUID})\\]?$`, 'i');
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** Resolve a pasted Forge reference through the operator-owned store, never a caller path. */
export async function viewForgeArtifactReference(attachmentId) {
  const match = typeof attachmentId === 'string' && REFERENCE.exec(attachmentId);
  if (!match || (attachmentId.startsWith('[') !== attachmentId.endsWith(']'))) return { ok: false, error: 'forge_reference_invalid' };
  const store = forgeStore();
  if (!store) return { ok: false, error: 'forge_unavailable' };
  let artifact, resolved;
  try { ({ artifact, resolved } = await store.artifact(match[1], match[2])); }
  catch { return { ok: false, error: 'forge_artifact_not_found' }; }
  const type = String(artifact.mimeType || '').toLowerCase();
  if (!MODEL_VISIBLE_IMAGE_TYPES.has(type)) return { ok: false, error: 'forge_artifact_image_type_unsupported' };
  let handle;
  try {
    handle = await fs.open(resolved.filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile()) return { ok: false, error: 'forge_artifact_not_found' };
    if (stat.size > MAX_IMAGE_BYTES) return { ok: false, error: 'forge_artifact_too_large' };
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== bytes.length) return { ok: false, error: 'forge_artifact_not_found' };
    return { ok: true, attachment: { id: attachmentId, name: artifact.name, type, size: bytes.length,
      kind: 'image', dataUrl: `data:${type};base64,${bytes.toString('base64')}` } };
  } catch { return { ok: false, error: 'forge_artifact_not_found' }; }
  finally { await handle?.close(); }
}
