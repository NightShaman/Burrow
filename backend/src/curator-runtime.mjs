import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promises as fs } from 'node:fs';
import { createModelAdapter } from './model-adapter.mjs';
import { resolveModelConfig } from './config.mjs';
import { getSettingsMeta, setSettingsMeta, openSettingsDatabase, settingsDatabasePath } from './settings-database.mjs';

export const CURATOR_SETTINGS_KEY = ['curator', 'selection'].join('_');
export const CURATOR_LOCAL_BACKEND = 'node-llama-cpp';

export const CURATOR_JSON_SCHEMA = {
  oneOf: [
    {
      type: 'object', additionalProperties: false, required: ['action', 'reason'],
      properties: { action: { const: 'NOOP' }, reason: { type: 'string', minLength: 12, maxLength: 240 } },
    },
    ...['ADD', 'UPDATE', 'RESOLVE', 'SUPERSEDE'].map((action) => ({
      type: 'object', additionalProperties: false,
      required: ['action', 'targetId', 'kind', 'title', 'content', 'sourceRefs', 'reason'],
      properties: {
        action: { const: action },
        targetId: action === 'ADD' ? { type: 'null' } : { type: 'string', minLength: 1 },
        kind: { enum: ['decision', 'finding', 'blocker', 'handoff', 'task'] },
        title: { type: 'string', minLength: 1, maxLength: 240 },
        content: { type: 'string', minLength: 1, maxLength: 1800 },
        sourceRefs: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1, maxItems: 1 },
        reason: { type: 'string', minLength: 12, maxLength: 240 },
      },
    })),
  ],
};
const text = (value) => String(value ?? '').trim();
const positive = (value, fallback) => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback;
const temperature = (value, fallback = 0) => {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 0.5) throw new Error('curator_temperature_invalid');
  return parsed;
};

export function curatorRoot({ runtimeRoot = process.env.BURROW_RUNTIME_ROOT || '/mnt/local/burrow' } = {}) {
  return path.resolve(runtimeRoot, 'curator');
}
function inside(root, candidate) { const relative = path.relative(root, candidate); return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)); }
export function curatorRuntimeRoot(root = curatorRoot()) { return path.join(root, 'runtime'); }
export function localCuratorModuleEntry(root = curatorRoot()) {
  const runtimeRoot = curatorRuntimeRoot(root);
  const entry = path.join(runtimeRoot, 'node_modules', CURATOR_LOCAL_BACKEND, 'dist', 'index.js');
  if (!inside(runtimeRoot, entry)) throw new Error('curator_local_runtime_path_invalid');
  return entry;
}
async function loadLocalCuratorModule(root = curatorRoot()) {
  const entry = localCuratorModuleEntry(root);
  await fs.access(entry);
  return import(pathToFileURL(entry).href);
}
function localModelPath(root, value) {
  const requested = text(value);
  if (!requested) throw new Error('curator_local_model_path_required');
  const resolved = path.resolve(root, requested);
  if (!inside(root, resolved) || path.extname(resolved).toLowerCase() !== '.gguf') throw new Error('curator_local_model_path_invalid');
  return resolved;
}
export function normalizeCuratorSelection(input = {}, { root = curatorRoot() } = {}) {
  const kind = text(input.kind || input.type).toLowerCase();
  if (kind === 'external') {
    const connectionId = text(input.connectionId || input.modelConnectionId);
    const model = text(input.model || input.modelId);
    if (!connectionId || !model) throw new Error('curator_external_selection_invalid');
    return { version: 1, kind, connectionId, model, temperature: temperature(input.temperature) };
  }
  if (kind === 'local') return {
    version: 1,
    kind,
    backend: CURATOR_LOCAL_BACKEND,
    modelPath: path.relative(root, localModelPath(root, input.modelPath)).split(path.sep).join('/'),
    contextSize: positive(input.contextSize, 4096),
    gpuLayers: Number.isFinite(Number(input.gpuLayers)) ? Number(input.gpuLayers) : 0,
    temperature: temperature(input.temperature),
  };
  throw new Error('curator_selection_kind_invalid');
}
export function readCuratorSelection({ databasePath, root } = {}) {
  const db = openSettingsDatabase({ databasePath: databasePath || settingsDatabasePath() });
  try { const value = getSettingsMeta(db, CURATOR_SETTINGS_KEY); return value ? normalizeCuratorSelection(value, { root: root || curatorRoot() }) : null; }
  finally { db.close(); }
}
export function saveCuratorSelection(input = {}, { databasePath, root } = {}) {
  const db = openSettingsDatabase({ databasePath: databasePath || settingsDatabasePath() });
  try { const selection = normalizeCuratorSelection(input, { root: root || curatorRoot() }); setSettingsMeta(db, CURATOR_SETTINGS_KEY, selection); return selection; }
  finally { db.close(); }
}
export async function curatorRuntimeStatus({ databasePath, root = curatorRoot() } = {}) {
  const selection = readCuratorSelection({ databasePath, root });
  if (!selection) return { configured: false, selection: null, root, available: false, reason: 'curator_selection_required' };
  if (selection.kind === 'external') return { configured: true, selection, root, available: true, implementation: 'model-connection' };
  const modelPath = localModelPath(root, selection.modelPath);
  const exists = await fs.stat(modelPath).then((stat) => stat.isFile()).catch(() => false);
  return { configured: true, selection, root, available: exists, implementation: CURATOR_LOCAL_BACKEND, modelPath, reason: exists ? null : 'curator_local_model_missing' };
}
async function completeLocal({ selection, root, prompt, jsonSchema = CURATOR_JSON_SCHEMA }) {
  const modelPath = localModelPath(root, selection.modelPath);
  await fs.access(modelPath);
  const { getLlama, LlamaChatSession } = await loadLocalCuratorModule(root);
  const llama = await getLlama();
  let model; let context; let grammar;
  try {
    model = await llama.loadModel({ modelPath, gpuLayers: selection.gpuLayers });
    grammar = await llama.createGrammarForJsonSchema(jsonSchema || CURATOR_JSON_SCHEMA);
    context = await model.createContext({ contextSize: selection.contextSize, sequences: 1 });
    const session = new LlamaChatSession({ contextSequence: context.getSequence() });
    const content = await session.prompt(prompt, { temperature: temperature(selection.temperature), maxTokens: 900, grammar, trimWhitespaceSuffix: true });
    return { choice: { text: String(content || '') }, provider: CURATOR_LOCAL_BACKEND, model: selection.modelPath };
  } finally { await grammar?.dispose?.(); await context?.dispose?.(); await model?.dispose?.(); await llama?.dispose?.(); }
}
export async function completeCurator({ selection, databasePath, root = curatorRoot(), prompt, jsonSchema = null, traceLogger = null } = {}) {
  if (!selection) throw new Error('curator_selection_required');
  if (selection.kind === 'external') {
    if (!databasePath) throw new Error('curator_settings_database_required');
    const config = await resolveModelConfig({ modelConnectionId: selection.connectionId, model: selection.model, settingsDb: databasePath });
    if (!config) throw new Error('curator_external_model_unavailable');
    const result = await createModelAdapter({ config: { ...config, reasoningEffort: 'off', temperature: temperature(selection.temperature) } }).complete({ messages: [{ role: 'user', content: prompt }], traceLogger });
    if (!result?.ok) throw new Error(result?.error || 'curator_external_completion_failed');
    return { ...result, implementation: 'model-connection' };
  }
  return { ...(await completeLocal({ selection, root, prompt, jsonSchema })), implementation: CURATOR_LOCAL_BACKEND };
}
