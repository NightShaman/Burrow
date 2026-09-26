import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { promises as fs } from 'node:fs';
import { createOpenAIGeneratedArtifactAdapter, generatedArtifactKind } from './model-adapters/openai-generated-artifacts.mjs';
import { persistGeneratedArtifact, resolveGeneratedArtifact } from './generated-artifact-store.mjs';
import { persistChatAttachments } from './attachment-store.mjs';
import { readSessionMetadata, appendSessionTurnIfAbsent } from './session-store.mjs';

const fail = (error, statusCode = 400) => { throw Object.assign(new Error(error), { statusCode }); };
const now = () => new Date().toISOString();
export function forgeCatalog(connections) {
  const models = connections.flatMap(c => (c.models || []).filter(m => m.selected !== false).flatMap(m => {
    const outputs = m.acceptedOutput ?? m.discoveredOutput ?? [];
    const kind = outputs.includes('video') ? 'video' : generatedArtifactKind({ capabilities: { outputs } });
    if (!kind) return [];
    const available = kind !== 'video' && /^openai-/.test(c.apiType);
    return [{ connectionId: c.id, modelId: m.id, label: m.name || m.id, kind, available, unavailableReason: available ? null : kind === 'video' ? 'video_provider_contract_unavailable' : 'provider_contract_unavailable', controls: [] }];
  }));
  return { ok: true, models, sourceAttachments: { available: false, reason: 'source_attachments_unsupported' }, video: { available: false, reason: 'video_provider_contract_unavailable' } };
}

/** One instance per server. SQLite claims are committed before any paid dispatch. */
export class ForgeStore {
  constructor({ databasePath, resolveAgent, connections, resolveConfig, adapterFactory = createOpenAIGeneratedArtifactAdapter }) {
    this.db = new DatabaseSync(databasePath);
    this.db.exec(`PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS forge_jobs (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, idem TEXT NOT NULL, request TEXT NOT NULL, record TEXT NOT NULL, UNIQUE(agent_id,idem));`);
    this.resolveAgent = resolveAgent; this.connections = connections; this.resolveConfig = resolveConfig; this.adapterFactory = adapterFactory;
    for (const row of this.db.prepare('SELECT record FROM forge_jobs').all()) {
      const job = JSON.parse(row.record);
      if (['queued', 'running'].includes(job.status)) { job.status = 'interrupted'; job.error = 'generation_interrupted'; this.save(job); }
    }
    this.pending = new Set();
  }
  save(job) { job.updatedAt = now(); this.db.prepare('UPDATE forge_jobs SET record=? WHERE id=?').run(JSON.stringify(job), job.id); }
  catalog() { return forgeCatalog(this.connections()); }
  async owner(agentId) {
    if (typeof agentId !== 'string' || !agentId.trim()) fail('agent_id_required');
    const owner = await this.resolveAgent(agentId);
    if (!owner || owner.agentId !== agentId) fail('forge_job_not_found', 404);
    return owner;
  }
  public(job) {
    return { ...job, artifacts: job.artifacts.map(({ storageReference, ...a }) => {
      const url = `/api/forge/jobs/${job.id}/artifacts/${a.id}?agentId=${encodeURIComponent(job.agentId)}`;
      return { ...a, previewUrl: url, downloadUrl: `${url}&download=1` };
    }) };
  }
  get(agentId, id) {
    const row = this.db.prepare('SELECT record FROM forge_jobs WHERE id=? AND agent_id=?').get(id, agentId);
    if (!row) fail('forge_job_not_found', 404);
    return JSON.parse(row.record);
  }
  async list(agentId) { await this.owner(agentId); return this.db.prepare('SELECT record FROM forge_jobs WHERE agent_id=? ORDER BY rowid DESC').all(agentId).map(r => this.public(JSON.parse(r.record))); }
  async create(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail('forge_request_invalid');
    if ('attachments' in body || 'sourceAttachments' in body) fail('source_attachments_unsupported');
    if ('options' in body) fail('generation_options_unsupported');
    const keys = ['agentId', 'connectionId', 'modelId', 'prompt', 'idempotencyKey'];
    if (Object.keys(body).some(k => !keys.includes(k)) || keys.some(k => typeof body[k] !== 'string' || !body[k].trim())) fail('forge_request_invalid');
    const owner = await this.owner(body.agentId);
    const request = JSON.stringify(keys.map(k => body[k]));
    const existing = this.db.prepare('SELECT request, record FROM forge_jobs WHERE agent_id=? AND idem=?').get(body.agentId, body.idempotencyKey);
    if (existing) { if (existing.request !== request) fail('idempotency_conflict', 409); return { job: this.public(JSON.parse(existing.record)), replayed: true }; }
    const model = this.catalog().models.find(m => m.connectionId === body.connectionId && m.modelId === body.modelId && m.available);
    if (!model) fail('forge_model_unavailable', 409);
    const job = { id: randomUUID(), ...body, kind: model.kind, status: 'queued', createdAt: now(), updatedAt: now(), error: null, artifacts: [] };
    // No await between uniqueness check and insert; concurrent requests cannot both dispatch.
    this.db.prepare('INSERT INTO forge_jobs VALUES (?,?,?,?,?)').run(job.id, job.agentId, job.idempotencyKey, request, JSON.stringify(job));
    const task = new Promise(resolve => setImmediate(resolve)).then(() => this.run(job, owner)).finally(() => this.pending.delete(task));
    this.pending.add(task);
    return { job: this.public(job), replayed: false };
  }
  async run(job, owner) {
    try {
      job.status = 'running'; this.save(job);
      const config = await this.resolveConfig(job.connectionId, job.modelId);
      if (!config || generatedArtifactKind(config) !== job.kind || !/^openai-/.test(config.api)) throw new Error('unavailable');
      const result = await this.adapterFactory({ config }).complete({ prompt: job.prompt });
      if (!result.ok || !result.outputArtifacts?.length) throw new Error('generation failed');
      for (const artifact of result.outputArtifacts) {
        const stored = await persistGeneratedArtifact({ agentWorkspaceRoot: owner.agentWorkspaceRoot, metadata: artifact, bytes: artifact.source?.bytes });
        job.artifacts.push({ id: randomUUID(), kind: stored.kind, name: stored.name, mimeType: stored.mimeType, sizeBytes: stored.sizeBytes, storageReference: stored.storageReference });
      }
      job.status = 'succeeded'; this.save(job);
    } catch {
      // A multi-artifact response is atomic: do not retain earlier files if a later write fails.
      const retained = [];
      for (const artifact of job.artifacts) {
        try {
          const resolved = await resolveGeneratedArtifact({ agentWorkspaceRoot: owner.agentWorkspaceRoot, storageReference: artifact.storageReference });
          if (resolved) await fs.rm(resolved.filePath, { force: true });
        } catch {
          // Keep a durable reference if the filesystem refuses cleanup, rather than orphaning it.
          retained.push(artifact);
        }
      }
      job.artifacts = retained;
      job.status = 'failed'; job.error = 'generation_failed'; this.save(job);
    }
  }
  async artifact(agentId, id, artifactId) {
    const owner = await this.owner(agentId); const job = this.get(agentId, id);
    const artifact = job.artifacts.find(a => a.id === artifactId);
    if (!artifact) fail('forge_artifact_not_found', 404);
    const resolved = await resolveGeneratedArtifact({ agentWorkspaceRoot: owner.agentWorkspaceRoot, storageReference: artifact.storageReference });
    if (!resolved) fail('forge_artifact_not_found', 404);
    return { owner, job, artifact, resolved };
  }
  async attach(id, body) {
    if (!body || Object.keys(body).some(k => !['agentId','sessionId','artifactId'].includes(k)) || ['agentId','sessionId','artifactId'].some(k => typeof body[k] !== 'string' || !body[k]) || (!/^[A-Za-z0-9._-]{1,120}$/.test(body.sessionId) || ['.', '..'].includes(body.sessionId) || body.sessionId.startsWith('-') || body.sessionId.endsWith('-'))) fail('forge_request_invalid');
    const { owner, job, artifact, resolved } = await this.artifact(body.agentId, id, body.artifactId);
    if (job.status !== 'succeeded') fail('forge_job_not_succeeded', 409);
    const rootDir = owner.agentWorkspaceRoot;
    if (!await readSessionMetadata({ rootDir, sessionId: body.sessionId })) fail('session_not_found', 404);
    const entry = await appendSessionTurnIfAbsent({ rootDir, sessionId: body.sessionId, role: 'user', content: '',
      // Persist only after the session's locked idempotency check; attachment storage is timestamp-based.
      metadata: async () => {
        const bytes = await fs.readFile(resolved.filePath);
        const [stored] = await persistChatAttachments({ agentWorkspaceRoot: rootDir, attachments: [{ name: artifact.name, type: artifact.mimeType, content: `data:${artifact.mimeType};base64,${bytes.toString('base64')}` }] });
        const { content, ...metadata } = stored;
        return { attachments: [metadata] };
      }, idempotencyKey: `forge:${job.id}:${artifact.id}` });
    const attached = entry.metadata.attachments[0];
    return { id: attached.artifactPath, ...attached, sessionId: body.sessionId };
  }
}
