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
  return { ok: true, models, music: { available: false, reason: 'music_model_not_configured' }, sourceAttachments: { available: false, reason: 'source_attachments_unsupported' }, video: { available: false, reason: 'video_provider_contract_unavailable' } };
}

/** One instance per server. SQLite claims are committed before any paid dispatch. */
export class ForgeStore {
  constructor({ databasePath, resolveAgent, resolveOperator, runtimeRoot, connections, resolveConfig, adapterFactory = createOpenAIGeneratedArtifactAdapter }) {
    this.db = new DatabaseSync(databasePath);
    this.db.exec(`PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS forge_jobs (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, idem TEXT NOT NULL, request TEXT NOT NULL, record TEXT NOT NULL);`);
    // Older databases used (agent_id, idem) as the key. Ownership is now operator-wide;
    // remove that constraint so duplicate historical keys remain readable during migration.
    const indexed = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='forge_jobs'").get()?.sql || '';
    if (/UNIQUE\s*\(\s*agent_id\s*,\s*idem/i.test(indexed)) {
      this.db.exec(`BEGIN IMMEDIATE; ALTER TABLE forge_jobs RENAME TO forge_jobs_legacy; CREATE TABLE forge_jobs (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, idem TEXT NOT NULL, request TEXT NOT NULL, record TEXT NOT NULL); INSERT INTO forge_jobs SELECT id,agent_id,idem,request,record FROM forge_jobs_legacy; DROP TABLE forge_jobs_legacy; COMMIT;`);
    }
    this.resolveAgent = resolveAgent; this.resolveOperator = resolveOperator || (async () => ({ operatorId: 'default', agentWorkspaceRoot: runtimeRoot })); this.runtimeRoot = runtimeRoot; this.connections = connections; this.resolveConfig = resolveConfig; this.adapterFactory = adapterFactory;
    for (const row of this.db.prepare('SELECT id,agent_id,record FROM forge_jobs').all()) {
      const job = JSON.parse(row.record);
      // Preserve the historical source root permanently; new output is runtime-owned.
      if (row.agent_id !== '__operator__' || job.agentId) {
        if (!job.legacySourceAgentId) job.legacySourceAgentId = job.agentId || row.agent_id;
        delete job.agentId;
        delete job.legacyAgentId;
        this.db.prepare("UPDATE forge_jobs SET agent_id='__operator__', record=? WHERE id=?").run(JSON.stringify(job), row.id);
      }
      if (['queued', 'running'].includes(job.status)) { job.status = 'interrupted'; job.error = 'generation_interrupted'; this.save(job); }
    }
    this.pending = new Set();
  }
  save(job) { job.updatedAt = now(); this.db.prepare('UPDATE forge_jobs SET record=? WHERE id=?').run(JSON.stringify(job), job.id); }
  catalog() { return forgeCatalog(this.connections()); }
  async owner() {
    const owner = await this.resolveOperator();
    if (!owner || !owner.agentWorkspaceRoot) fail('forge_owner_unavailable', 503);
    return owner;
  }
  public(job) {
    const { storageReference, agentId, legacyAgentId, legacySourceAgentId, ...safeJob } = job;
    return { ...safeJob, artifacts: job.artifacts.map(({ storageReference: ref, ...a }) => {
      const url = `/api/forge/jobs/${job.id}/artifacts/${a.id}`;
      return { ...a, previewUrl: url, downloadUrl: `${url}?download=1` };
    }) };
  }
  get(id) {
    const row = this.db.prepare('SELECT record FROM forge_jobs WHERE id=?').get(id);
    if (!row) fail('forge_job_not_found', 404);
    const job = JSON.parse(row.record);
    if (job.agentId && !job.legacySourceAgentId) job.legacySourceAgentId = job.agentId;
    return job;
  }
  async list() { await this.owner(); return this.db.prepare('SELECT record FROM forge_jobs ORDER BY rowid DESC').all().map(r => this.public(JSON.parse(r.record))); }
  async create(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail('forge_request_invalid');
    if ('attachments' in body || 'sourceAttachments' in body) fail('source_attachments_unsupported');
    if ('options' in body) fail('generation_options_unsupported');
    const keys = ['connectionId', 'modelId', 'prompt', 'idempotencyKey'];
    if (Object.keys(body).some(k => !keys.includes(k)) || keys.some(k => typeof body[k] !== 'string' || !body[k].trim())) fail('forge_request_invalid');
    const owner = await this.owner();
    const request = JSON.stringify(keys.map(k => body[k]));
    // Migration can leave duplicate historical keys. A matching request is replayable;
    // any differing request conflicts, regardless of which legacy agent supplied it.
    const existingRows = this.db.prepare('SELECT request, record FROM forge_jobs WHERE idem=? ORDER BY rowid').all(body.idempotencyKey);
    const existing = existingRows.find(row => row.request === request) || existingRows[0];
    if (existing) { if (existing.request !== request) fail('idempotency_conflict', 409); return { job: this.public(JSON.parse(existing.record)), replayed: true }; }
    const model = this.catalog().models.find(m => m.connectionId === body.connectionId && m.modelId === body.modelId && m.available);
    if (!model) fail('forge_model_unavailable', 409);
    const job = { id: randomUUID(), ...body, kind: model.kind, status: 'queued', createdAt: now(), updatedAt: now(), error: null, artifacts: [] };
    this.db.prepare('INSERT INTO forge_jobs VALUES (?,?,?,?,?)').run(job.id, '__operator__', job.idempotencyKey, request, JSON.stringify(job));
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
        const stored = await persistGeneratedArtifact({ agentWorkspaceRoot: this.runtimeRoot || owner.agentWorkspaceRoot, metadata: artifact, bytes: artifact.source?.bytes });
        job.artifacts.push({ id: randomUUID(), kind: stored.kind, name: stored.name, mimeType: stored.mimeType, sizeBytes: stored.sizeBytes, storageReference: stored.storageReference });
      }
      job.status = 'succeeded'; this.save(job);
    } catch {
      // A multi-artifact response is atomic: do not retain earlier files if a later write fails.
      const retained = [];
      for (const artifact of job.artifacts) {
        try {
          const resolved = await resolveGeneratedArtifact({ agentWorkspaceRoot: job.legacySourceAgentId ? (await this.resolveAgent(job.legacySourceAgentId)).agentWorkspaceRoot : (this.runtimeRoot || owner.agentWorkspaceRoot), storageReference: artifact.storageReference });
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
  async artifact(id, artifactId) {
    const job = this.get(id); const owner = job.legacySourceAgentId ? await this.resolveAgent(job.legacySourceAgentId) : await this.owner();
    if (!owner?.agentWorkspaceRoot) fail('forge_artifact_not_found', 404);
    const artifact = job.artifacts.find(a => a.id === artifactId);
    if (!artifact) fail('forge_artifact_not_found', 404);
    const resolved = await resolveGeneratedArtifact({ agentWorkspaceRoot: job.legacySourceAgentId ? (await this.resolveAgent(job.legacySourceAgentId)).agentWorkspaceRoot : (this.runtimeRoot || owner.agentWorkspaceRoot), storageReference: artifact.storageReference });
    if (!resolved) fail('forge_artifact_not_found', 404);
    return { owner, job, artifact, resolved };
  }
  async attach(id, body) {
    if (!body || Object.keys(body).some(k => !['agentId','sessionId','artifactId'].includes(k)) || ['agentId','sessionId','artifactId'].some(k => typeof body[k] !== 'string' || !body[k]) || (!/^[A-Za-z0-9._-]{1,120}$/.test(body.sessionId) || ['.', '..'].includes(body.sessionId) || body.sessionId.startsWith('-') || body.sessionId.endsWith('-'))) fail('forge_request_invalid');
    const destination = await this.resolveAgent(body.agentId);
    if (!destination?.agentWorkspaceRoot || destination.agentId !== body.agentId) fail('session_not_found', 404);
    const { job, artifact, resolved } = await this.artifact(id, body.artifactId);
    if (job.status !== 'succeeded') fail('forge_job_not_succeeded', 409);
    const rootDir = destination.agentWorkspaceRoot;
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
