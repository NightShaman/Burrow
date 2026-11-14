import { randomUUID } from 'node:crypto';
import { withPostgresTransaction } from './postgres-foundation.mjs';

// Forge is operator-wide in this runtime, including legacy agent-generated jobs.
// Placements reference generated artifacts only; no chat attachment ingestion.
export const POSTGRES_FORGE_GALLERY_SCHEMA_SQL = `
CREATE TABLE forge_gallery_folders (
 id TEXT PRIMARY KEY,
 name TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
 parent_id TEXT REFERENCES forge_gallery_folders(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX forge_gallery_folders_parent_idx ON forge_gallery_folders(parent_id);
CREATE TABLE forge_gallery_placements (
 job_id TEXT NOT NULL REFERENCES forge_jobs(id) ON DELETE CASCADE,
 artifact_id TEXT NOT NULL,
 folder_id TEXT NOT NULL REFERENCES forge_gallery_folders(id),
 PRIMARY KEY(job_id,artifact_id)
);
CREATE INDEX forge_gallery_placements_folder_idx ON forge_gallery_placements(folder_id);
`;
const fail = (error, statusCode = 400) => { throw Object.assign(new Error(error), { statusCode }); };
const parse = value => typeof value === 'string' ? JSON.parse(value) : value;
const folder = row => ({ id: row.id, name: row.name, parentId: row.parent_id,
  createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString() });
const eligibleJob = job => job.status === 'succeeded' && job.kind === 'image' && !job.modOwnerId;
const eligibleArtifact = artifact => artifact.kind === 'image' && typeof artifact.id === 'string' &&
  typeof artifact.storageReference === 'string' && artifact.storageReference.length > 0 &&
  typeof artifact.mimeType === 'string' && artifact.mimeType.startsWith('image/');
const validId = id => typeof id === 'string' && id.length > 0 && id.length <= 200;
function folderId(body, key) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.hasOwn(body, key) ||
    (body[key] !== null && !validId(body[key]))) fail('forge_gallery_request_invalid');
  return body[key];
}
async function requireFolder(client, id) {
  if (id !== null && !(await client.query('SELECT 1 FROM forge_gallery_folders WHERE id=$1', [id])).rowCount)
    fail('forge_gallery_folder_not_found', 404);
}

export async function readForgeGallery(store) {
  await store.owner();
  // Single statement snapshot keeps folder/placement responses consistent.
  const result = await store.pool.query(`SELECT
    (SELECT COALESCE(jsonb_agg(to_jsonb(f) ORDER BY f.created_at,f.id),'[]'::jsonb) FROM forge_gallery_folders f) AS folders,
    (SELECT COALESCE(jsonb_agg(jsonb_build_object('record',j.record,'placements',
      (SELECT COALESCE(jsonb_object_agg(p.artifact_id,p.folder_id),'{}'::jsonb) FROM forge_gallery_placements p WHERE p.job_id=j.id))
      ORDER BY j.ordinal DESC,j.id DESC),'[]'::jsonb)
      FROM forge_jobs j WHERE j.status='succeeded' AND j.record->>'kind'='image'
        AND COALESCE(j.record->>'modOwnerId','')='') AS jobs`);
  const snapshot = result.rows[0];
  const images = [];
  for (const { record, placements } of parse(snapshot.jobs)) {
    const job = parse(record);
    if (!eligibleJob(job)) continue;
    for (const artifact of job.artifacts || []) {
      if (!eligibleArtifact(artifact)) continue;
      // Explicit public projection: never return file storage references, prompts,
      // provider request material, or private mod ownership metadata.
      const { id, kind, name, mimeType, sizeBytes } = artifact;
      const base = `/api/forge/jobs/${encodeURIComponent(job.id)}/artifacts/${encodeURIComponent(id)}`;
      images.push({ jobId: job.id, artifactId: id, folderId: placements[id] ?? null,
        createdAt: job.createdAt, artifact: { id, kind, name, mimeType, sizeBytes,
          previewUrl: base, downloadUrl: `${base}?download=1` } });
    }
  }
  return { folders: parse(snapshot.folders).map(folder), images };
}

export async function createForgeGalleryFolder(store, body) {
  await store.owner();
  // Parent defaults to root when omitted, matching ordinary creation forms.
  const parentId = folderId({ ...body, parentId: body?.parentId === undefined ? null : body.parentId }, 'parentId');
  if (typeof body?.name !== 'string' || !body.name.trim() || body.name.trim().length > 200)
    fail('forge_gallery_request_invalid');
  return withPostgresTransaction(store.pool, async client => {
    await requireFolder(client, parentId);
    const result = await client.query(`INSERT INTO forge_gallery_folders(id,name,parent_id)
      VALUES($1,$2,$3) RETURNING *`, [randomUUID(), body.name.trim(), parentId]);
    return folder(result.rows[0]);
  });
}

export async function moveForgeGalleryImage(store, jobId, artifactId, body) {
  await store.owner();
  if (!validId(jobId) || !validId(artifactId)) fail('forge_gallery_request_invalid');
  const target = folderId(body, 'folderId');
  return withPostgresTransaction(store.pool, async client => {
    const result = await client.query('SELECT record FROM forge_jobs WHERE id=$1 FOR SHARE', [jobId]);
    const job = result.rows[0] && parse(result.rows[0].record);
    if (!job || !eligibleJob(job) || !(job.artifacts || []).some(a => a.id === artifactId && eligibleArtifact(a)))
      fail('forge_gallery_image_not_found', 404);
    await requireFolder(client, target);
    if (target === null) await client.query('DELETE FROM forge_gallery_placements WHERE job_id=$1 AND artifact_id=$2', [jobId, artifactId]);
    else await client.query(`INSERT INTO forge_gallery_placements(job_id,artifact_id,folder_id) VALUES($1,$2,$3)
      ON CONFLICT(job_id,artifact_id) DO UPDATE SET folder_id=EXCLUDED.folder_id`, [jobId, artifactId, target]);
    return { jobId, artifactId, folderId: target };
  });
}
