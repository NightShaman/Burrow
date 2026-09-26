import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { promises as fs } from 'node:fs';
import { createOpenAIGeneratedArtifactAdapter, generatedArtifactKind } from './model-adapters/openai-generated-artifacts.mjs';
import { createGoogleLyriaAdapter, googleLyriaSupported } from './model-adapters/google-lyria.mjs';
import { persistGeneratedArtifact, resolveGeneratedArtifact } from './generated-artifact-store.mjs';
import { persistChatAttachments } from './attachment-store.mjs';
import { readSessionMetadata, appendSessionTurnIfAbsent } from './session-store.mjs';

const fail = (error, statusCode = 400) => { throw Object.assign(new Error(error), { statusCode }); };
const now = () => new Date().toISOString();
export function forgeCatalog(connections) {
  const models = connections.flatMap(c => (c.models || []).filter(m => m.selected !== false).flatMap(m => {
    const outputs = m.acceptedOutput ?? m.discoveredOutput ?? [];
    const google = googleLyriaSupported({ ...c, model: m.id });
    const effectiveOutputs = google && m.acceptedOutputOverride === undefined && m.acceptedOutput === undefined && !outputs.length ? ['audio'] : outputs;
    const kind = effectiveOutputs.includes('video') ? 'video' : generatedArtifactKind({ capabilities: { outputs: effectiveOutputs } });
    if (!kind) return [];
    const available = kind !== 'video' && ( /^openai-/.test(c.apiType) || (kind === 'audio' && google) );
    return [{ connectionId: c.id, modelId: m.id, label: m.name || m.id, kind, available, unavailableReason: available ? null : kind === 'video' ? 'video_provider_contract_unavailable' : 'provider_contract_unavailable', controls: [] }];
  }));
  const musicModels = models.filter(m => m.kind === 'audio' && m.available && googleLyriaSupported({ ...connections.find(c => c.id === m.connectionId), model: m.modelId }));
  const music = musicModels.length ? { available: true, reason: null, models: musicModels } : { available: false, reason: 'music_model_not_configured' };
  return { ok: true, models, music, sourceAttachments: { available: false, reason: 'source_attachments_unsupported' }, video: { available: false, reason: 'video_provider_contract_unavailable' } };
}

/** One instance per server. SQLite claims are committed before any paid dispatch. */
export class ForgeStore {
  constructor({ databasePath, resolveAgent, resolveOperator, runtimeRoot, connections, resolveConfig, adapterFactory = createOpenAIGeneratedArtifactAdapter, googleAdapterFactory = createGoogleLyriaAdapter }) {
    this.db = new DatabaseSync(databasePath);
    this.db.exec(`PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS forge_jobs (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, idem TEXT NOT NULL, request TEXT NOT NULL, record TEXT NOT NULL); CREATE TABLE IF NOT EXISTS forge_selections (mode TEXT PRIMARY KEY, connection_id TEXT NOT NULL, model_id TEXT NOT NULL, updated_at TEXT NOT NULL);`);
    // Older databases used (agent_id, idem) as the key. Ownership is now operator-wide;
    // remove that constraint so duplicate historical keys remain readable during migration.
    const indexed = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='forge_jobs'").get()?.sql || '';
    if (/UNIQUE\s*\(\s*agent_id\s*,\s*idem/i.test(indexed)) {
      this.db.exec(`BEGIN IMMEDIATE; ALTER TABLE forge_jobs RENAME TO forge_jobs_legacy; CREATE TABLE forge_jobs (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, idem TEXT NOT NULL, request TEXT NOT NULL, record TEXT NOT NULL); INSERT INTO forge_jobs SELECT id,agent_id,idem,request,record FROM forge_jobs_legacy; DROP TABLE forge_jobs_legacy; COMMIT;`);
    }
    this.resolveAgent = resolveAgent; this.googleAdapterFactory = googleAdapterFactory; this.resolveOperator = resolveOperator || (async () => ({ operatorId: 'default', agentWorkspaceRoot: runtimeRoot })); this.runtimeRoot = runtimeRoot; this.connections = connections; this.resolveConfig = resolveConfig; this.adapterFactory = adapterFactory;
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
  selections() {
    const out = {};
    for (const row of this.db.prepare('SELECT mode,connection_id,model_id FROM forge_selections').all()) out[row.mode] = { connectionId: row.connection_id, modelId: row.model_id };
    return out;
  }
  setSelection(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !['mode','connectionId','modelId'].includes(k)) || !['mode','connectionId','modelId'].every(k => typeof body[k] === 'string' && body[k].trim())) fail('forge_request_invalid');
    if (!['image','music','speech','video'].includes(body.mode)) fail('forge_request_invalid');
    const catalog = this.catalog();
    const row = catalog.models.find(m => m.connectionId === body.connectionId && m.modelId === body.modelId && ((body.mode === 'image' && m.kind === 'image') || (body.mode === 'video' && m.kind === 'video') || (body.mode === 'music' && m.kind === 'audio' && catalog.music.models?.some(x => x.connectionId === m.connectionId && x.modelId === m.modelId)) || (body.mode === 'speech' && m.kind === 'audio' && !catalog.music.models?.some(x => x.connectionId === m.connectionId && x.modelId === m.modelId))) && m.available);
    if (!row) fail('forge_model_unavailable', 409);
    this.db.prepare('INSERT INTO forge_selections(mode,connection_id,model_id,updated_at) VALUES(?,?,?,?) ON CONFLICT(mode) DO UPDATE SET connection_id=excluded.connection_id,model_id=excluded.model_id,updated_at=excluded.updated_at').run(body.mode, body.connectionId, body.modelId, now());
    return this.selections();
  }
  selectionMatches(mode, row, catalog = this.catalog()) {
    return row?.available && ((mode === 'image' && row.kind === 'image') || (mode === 'video' && row.kind === 'video') || (mode === 'music' && catalog.music.models?.some(x => x.connectionId === row.connectionId && x.modelId === row.modelId)) || (mode === 'speech' && row.kind === 'audio' && !catalog.music.models?.some(x => x.connectionId === row.connectionId && x.modelId === row.modelId)));
  }
  resolveSelection(mode) {
    const selection = this.selections()[mode];
    if (!selection) fail('forge_selection_missing', 409);
    const catalog = this.catalog();
    const row = catalog.models.find(m => m.connectionId === selection.connectionId && m.modelId === selection.modelId);
    if (!this.selectionMatches(mode, row, catalog)) fail('forge_model_unavailable', 409);
    return selection;
  }
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
    const keys = ['mode', 'connectionId', 'modelId', 'prompt', 'idempotencyKey'];
    if (Object.keys(body).some(k => !keys.includes(k)) || ['prompt','idempotencyKey'].some(k => typeof body[k] !== 'string' || !body[k].trim())) fail('forge_request_invalid');
    if (body.mode !== undefined && body.mode !== null && (typeof body.mode !== 'string' || !['image','music','speech','video'].includes(body.mode))) fail('forge_request_invalid');
    const explicitSelection = body.connectionId !== undefined || body.modelId !== undefined;
    if (explicitSelection && (typeof body.connectionId !== 'string' || typeof body.modelId !== 'string' || !body.connectionId.trim() || !body.modelId.trim())) fail('forge_request_invalid');
    if (!explicitSelection && (body.mode === undefined || body.mode === null)) fail('forge_selection_missing', 409);
    const catalog = this.catalog();
    const selected = explicitSelection ? { connectionId: body.connectionId, modelId: body.modelId } : this.selections()[body.mode];
    if (!selected) fail('forge_selection_missing', 409);
    if (typeof selected.connectionId !== 'string' || typeof selected.modelId !== 'string' || !selected.connectionId.trim() || !selected.modelId.trim()) fail('forge_request_invalid');
    const selectedModel = catalog.models.find(m => m.connectionId === selected.connectionId && m.modelId === selected.modelId);
    if (explicitSelection && body.mode !== undefined && body.mode !== null && !this.selectionMatches(body.mode, selectedModel, catalog)) fail('forge_model_unavailable', 409);
    const owner = await this.owner();
    const requestBody = { mode: body.mode ?? null, connectionId: selected.connectionId, modelId: selected.modelId, prompt: body.prompt, idempotencyKey: body.idempotencyKey };
    const requestIdentity = { ...requestBody, implicitSelection: !explicitSelection };
    const request = JSON.stringify(requestIdentity);
    // Migration can leave duplicate historical keys. A matching request is replayable;
    // any differing request conflicts, regardless of which legacy agent supplied it.
    const existingRows = this.db.prepare('SELECT request, record FROM forge_jobs WHERE idem=? ORDER BY rowid').all(requestBody.idempotencyKey);
    const existing = existingRows.find(row => row.request === request) || existingRows.find(row => { try { const prior = JSON.parse(row.record); const legacy = JSON.parse(row.request); return (!explicitSelection && prior.implicitSelection === true && prior.mode === body.mode && prior.prompt === body.prompt) || (explicitSelection && Array.isArray(legacy) && legacy[0] === selected.connectionId && legacy[1] === selected.modelId && legacy[2] === body.prompt && legacy[3] === body.idempotencyKey); } catch { return false; } }) || existingRows[0];
    if (existing) { let same = existing.request === request; if (!same) { try { const prior = JSON.parse(existing.record); const legacy = JSON.parse(existing.request); same = (!explicitSelection && prior.implicitSelection === true && prior.mode === body.mode && prior.prompt === body.prompt) || (explicitSelection && Array.isArray(legacy) && legacy[0] === selected.connectionId && legacy[1] === selected.modelId && legacy[2] === body.prompt && legacy[3] === body.idempotencyKey); } catch {} } if (!same) fail('idempotency_conflict', 409); return { job: this.public(JSON.parse(existing.record)), replayed: true }; }
    const model = this.catalog().models.find(m => m.connectionId === selected.connectionId && m.modelId === selected.modelId && m.available);
    if (!model) fail('forge_model_unavailable', 409);
    const job = { id: randomUUID(), ...requestBody, implicitSelection: !explicitSelection, kind: model.kind, status: 'queued', createdAt: now(), updatedAt: now(), error: null, artifacts: [] };
    this.db.prepare('INSERT INTO forge_jobs VALUES (?,?,?,?,?)').run(job.id, '__operator__', job.idempotencyKey, request, JSON.stringify(job));
    const task = new Promise(resolve => setImmediate(resolve)).then(() => this.run(job, owner)).finally(() => this.pending.delete(task));
    this.pending.add(task);
    return { job: this.public(job), replayed: false };
  }
  async run(job, owner) {
    try {
      job.status = 'running'; this.save(job);
      const config = await this.resolveConfig(job.connectionId, job.modelId);
      const google = job.kind === 'audio' && googleLyriaSupported(config);
      if (!config || (!google && (generatedArtifactKind(config) !== job.kind || !/^openai-/.test(config.api)))) throw new Error('unavailable');
      const adapter = google ? this.googleAdapterFactory({ config }) : this.adapterFactory({ config });
      const result = await adapter.complete({ prompt: job.prompt });
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
