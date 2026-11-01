import { constants as fsConstants, promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { normalizePostgresPool, withPostgresTransaction } from './postgres-foundation.mjs';
import { persistGeneratedArtifact, resolveGeneratedArtifact, deleteGeneratedArtifact } from './generated-artifact-store.mjs';
import { REFERENCE_IMAGE_MAX_BYTES } from './model-adapters/reference-image-capability.mjs';

export const POSTGRES_AGENT_REFERENCE_IMAGE_SQL = `
CREATE TABLE agent_reference_images (
 agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
 id TEXT NOT NULL UNIQUE,
 storage_reference TEXT NOT NULL UNIQUE,
 file_name TEXT NOT NULL,
 mime_type TEXT NOT NULL CHECK (mime_type IN ('image/png','image/jpeg','image/webp')),
 size_bytes INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 20971520),
 updated_at TIMESTAMPTZ NOT NULL
);
`;
const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };
const extensions = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
export const REFERENCE_IMAGE_ATTACHMENT_PREFIX = 'agent-reference-image:';

export function validateReferenceImageUpload(body) {
  if (!body || Array.isArray(body) || typeof body !== 'object' || Object.keys(body).some(key => !['fileName', 'content'].includes(key)) ||
    typeof body.fileName !== 'string' || !body.fileName.trim() || typeof body.content !== 'string') fail('agent_reference_image_invalid');
  if (body.content.length > Math.ceil(REFERENCE_IMAGE_MAX_BYTES / 3) * 4 + 64) fail('agent_reference_image_too_large', 413);
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(body.content);
  if (!match || match[2].length % 4 !== 0) fail('agent_reference_image_invalid');
  const [, mimeType, encoded] = match;
  const bytes = Buffer.from(encoded, 'base64');
  if (!bytes.length || bytes.toString('base64') !== encoded) fail('agent_reference_image_invalid');
  if (bytes.length > REFERENCE_IMAGE_MAX_BYTES) fail('agent_reference_image_too_large', 413);
  const validSignature = mimeType === 'image/png'
    ? bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString('ascii', 12, 16) === 'IHDR' && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0
    : mimeType === 'image/jpeg'
      ? bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes.at(-2) === 255 && bytes.at(-1) === 217
      : bytes.length >= 16 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' && bytes.readUInt32LE(4) + 8 === bytes.length;
  if (!validSignature) fail('agent_reference_image_invalid');
  const fileName = path.basename(body.fileName).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 160) || `reference.${extensions[mimeType]}`;
  return { bytes, mimeType, fileName };
}

function metadata(row) {
  if (!row) return null;
  return {
    id: row.id,
    attachmentId: `${REFERENCE_IMAGE_ATTACHMENT_PREFIX}${row.id}`,
    contentUrl: `/api/agents/${encodeURIComponent(row.agent_id)}/reference-image/content?id=${encodeURIComponent(row.id)}`,
    mimeType: row.mime_type,
    fileName: row.file_name,
    sizeBytes: row.size_bytes,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

/** Global Core-owned image bytes; SQL owns the agent link. Never a Node Goblin
 * workspace file or an expiring conversation attachment. Ordinary attachment
 * retention and execution-host changes cannot discard the canonical portrait. */
export class PostgresAgentReferenceImageStore {
  constructor({ pool, runtimeRoot, logger = console } = {}) {
    this.pool = normalizePostgresPool(pool);
    this.runtimeRoot = runtimeRoot;
    this.logger = logger;
  }
  async requireAgent(agentId, client = this.pool, lock = '') {
    if (typeof agentId !== 'string' || !agentId) fail('agent_not_found', 404);
    const result = await client.query(`SELECT id FROM agents WHERE id=$1${lock}`, [agentId]);
    if (!result.rowCount) fail('agent_not_found', 404);
  }
  async get(agentId) {
    await this.requireAgent(agentId);
    const result = await this.pool.query('SELECT * FROM agent_reference_images WHERE agent_id=$1', [agentId]);
    return metadata(result.rows[0]);
  }
  async discard(storageReference) {
    if (!storageReference) return;
    try { await deleteGeneratedArtifact({ agentWorkspaceRoot: this.runtimeRoot, storageReference }); }
    catch { this.logger.warn?.('Agent reference image file cleanup failed'); }
  }
  async put(agentId, body) {
    const { bytes, mimeType, fileName } = validateReferenceImageUpload(body);
    let created, previous;
    try {
      const image = await withPostgresTransaction(this.pool, async client => {
        // Serializes replace/remove/read and agent deletion without allocating a
        // second database connection (also works with max:1 pools).
        await this.requireAgent(agentId, client, ' FOR UPDATE');
        const old = await client.query('SELECT storage_reference FROM agent_reference_images WHERE agent_id=$1', [agentId]);
        previous = old.rows[0]?.storage_reference;
        created = await persistGeneratedArtifact({ agentWorkspaceRoot: this.runtimeRoot, metadata: { kind: 'image', name: fileName, mimeType }, bytes });
        const result = await client.query(`INSERT INTO agent_reference_images(agent_id,id,storage_reference,file_name,mime_type,size_bytes,updated_at)
          VALUES($1,$2,$3,$4,$5,$6,CURRENT_TIMESTAMP)
          ON CONFLICT(agent_id) DO UPDATE SET id=EXCLUDED.id,storage_reference=EXCLUDED.storage_reference,file_name=EXCLUDED.file_name,mime_type=EXCLUDED.mime_type,size_bytes=EXCLUDED.size_bytes,updated_at=EXCLUDED.updated_at RETURNING *`,
        [agentId, randomUUID(), created.storageReference, fileName, mimeType, bytes.length]);
        return metadata(result.rows[0]);
      });
      await this.discard(previous);
      return image;
    } catch (error) {
      if (created) {
        // A lost COMMIT acknowledgement is not proof of rollback. Only remove
        // the new bytes after SQL confirms they are not the current portrait.
        // If reconciliation is unavailable, leave the owned file intact.
        try {
          const retained = await this.pool.query('SELECT 1 FROM agent_reference_images WHERE storage_reference=$1', [created.storageReference]);
          if (!retained.rowCount) await this.discard(created.storageReference);
          else await this.discard(previous);
        } catch { this.logger.warn?.('Agent reference image commit outcome could not be reconciled'); }
      }
      throw error;
    }
  }
  async remove(agentId) {
    const old = await withPostgresTransaction(this.pool, async client => {
      await this.requireAgent(agentId, client, ' FOR UPDATE');
      const result = await client.query('DELETE FROM agent_reference_images WHERE agent_id=$1 RETURNING storage_reference', [agentId]);
      return result.rows[0]?.storage_reference;
    });
    await this.discard(old);
    return null;
  }
  async read(agentId, id = null) {
    return withPostgresTransaction(this.pool, async client => {
      await this.requireAgent(agentId, client, ' FOR SHARE');
      const result = await client.query('SELECT * FROM agent_reference_images WHERE agent_id=$1', [agentId]);
      const row = result.rows[0];
      if (!row || (id !== null && id !== row.id)) fail('agent_reference_image_not_found', 404);
      const resolved = await resolveGeneratedArtifact({ agentWorkspaceRoot: this.runtimeRoot, storageReference: row.storage_reference });
      if (!resolved || resolved.stat.size !== row.size_bytes || resolved.stat.size > REFERENCE_IMAGE_MAX_BYTES) fail('agent_reference_image_not_found', 404);
      const handle = await fs.open(resolved.filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size !== row.size_bytes) fail('agent_reference_image_not_found', 404);
        const bytes = Buffer.alloc(row.size_bytes);
        let offset = 0;
        while (offset < bytes.length) {
          const next = await handle.read(bytes, offset, bytes.length - offset, offset);
          if (!next.bytesRead) fail('agent_reference_image_not_found', 404);
          offset += next.bytesRead;
        }
        return { image: metadata(row), bytes };
      } finally { await handle.close(); }
    });
  }
  async view(agentId, attachmentId) {
    const id = attachmentId.slice(REFERENCE_IMAGE_ATTACHMENT_PREFIX.length);
    const { image, bytes } = await this.read(agentId, id);
    return { id: image.attachmentId, name: image.fileName, type: image.mimeType, size: image.sizeBytes, storedAt: image.updatedAt, kind: 'image', dataUrl: `data:${image.mimeType};base64,${bytes.toString('base64')}` };
  }
}
