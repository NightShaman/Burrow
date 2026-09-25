export const MODEL_OUTPUT_ARTIFACT_KINDS = Object.freeze(['audio', 'image', 'video', 'file']);
export const MODEL_OUTPUT_ARTIFACT_CONTRACT_VERSION = 1;

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function nonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function kindFromMimeType(mimeType = '') {
  const prefix = text(mimeType).toLowerCase().split('/', 1)[0];
  return ['audio', 'image', 'video'].includes(prefix) ? prefix : (prefix ? 'file' : '');
}

function normalizeProvenance(value = {}, defaults = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const fields = {
    provider: text(source.provider ?? defaults.provider),
    model: text(source.model ?? defaults.model),
    requestId: text(source.requestId ?? source.request_id ?? defaults.requestId),
    responseId: text(source.responseId ?? source.response_id ?? defaults.responseId),
  };
  const provenance = Object.fromEntries(Object.entries(fields).filter(([, field]) => field));
  return Object.keys(provenance).length ? provenance : null;
}

export function normalizeModelOutputArtifact(value, provenanceDefaults = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const mimeType = text(value.mimeType ?? value.mime_type ?? value.mediaType ?? value.media_type).toLowerCase();
  const kind = text(value.kind ?? value.type).toLowerCase() || kindFromMimeType(mimeType);
  if (!MODEL_OUTPUT_ARTIFACT_KINDS.includes(kind)) return null;

  const artifact = {
    contractVersion: MODEL_OUTPUT_ARTIFACT_CONTRACT_VERSION,
    kind,
  };
  const id = text(value.id ?? value.artifactId ?? value.artifact_id);
  const name = text(value.name ?? value.filename ?? value.fileName);
  const uri = text(value.uri ?? value.url);
  const providerAssetId = text(value.providerAssetId ?? value.provider_asset_id);
  const storageReference = text(value.storageReference ?? value.storage_reference);
  const sizeBytes = nonNegativeNumber(value.sizeBytes ?? value.size_bytes ?? value.size);
  const durationMs = nonNegativeNumber(value.durationMs ?? value.duration_ms);
  const width = positiveInteger(value.width);
  const height = positiveInteger(value.height);
  const provenance = normalizeProvenance(value.provenance, provenanceDefaults);

  if (id) artifact.id = id;
  if (name) artifact.name = name;
  if (mimeType) artifact.mimeType = mimeType;
  if (uri) artifact.uri = uri;
  if (providerAssetId) artifact.providerAssetId = providerAssetId;
  if (storageReference) artifact.storageReference = storageReference;
  if (sizeBytes !== null) artifact.sizeBytes = sizeBytes;
  if (durationMs !== null) artifact.durationMs = durationMs;
  if (width !== null) artifact.width = width;
  if (height !== null) artifact.height = height;
  if (provenance) artifact.provenance = provenance;
  return artifact;
}

// This contract deliberately carries metadata and references only. Provider
// adapters may populate it when they can describe an output, but the runtime
// does not infer that bytes were generated, fetched, stored, or playable.
export function normalizeModelOutputArtifacts(values, provenanceDefaults = {}) {
  if (!Array.isArray(values)) return [];
  return values.map((value) => normalizeModelOutputArtifact(value, provenanceDefaults)).filter(Boolean);
}

export function modelOutputArtifactsFromAdapterResult(result = {}) {
  if (!result || typeof result !== 'object') return [];
  return normalizeModelOutputArtifacts(result.outputArtifacts ?? result.output_artifacts, {
    provider: result.provider,
    model: result.model,
    requestId: result.requestId ?? result.request_id,
    responseId: result.responseId ?? result.response_id,
  });
}

function artifactSource(value) {
  const source = value?.source;
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
  const keys = Object.keys(source);
  if (keys.length !== 1) return null;
  if (keys[0] === 'bytes') {
    const bytes = source.bytes;
    if (Buffer.isBuffer(bytes)) return { bytes };
    if (bytes instanceof Uint8Array) return { bytes: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) };
    return null;
  }
  if (keys[0] === 'localFile') {
    const local = source.localFile;
    if (!local || typeof local !== 'object' || Array.isArray(local)) return null;
    const filePath = text(local.filePath);
    const allowedRoot = text(local.allowedRoot);
    if (!filePath || !allowedRoot || /^[a-z][a-z0-9+.-]*:\/\//i.test(filePath)) return null;
    return { localSource: { filePath, allowedRoot } };
  }
  return null;
}

/**
 * Internal adapter-result contract. Sources are intentionally separated from
 * normalized public metadata so bytes can never enter session JSON or logs.
 */
export function adapterOutputArtifactsFromResult(result = {}) {
  if (!result || typeof result !== 'object') return [];
  const values = result.outputArtifacts ?? result.output_artifacts;
  if (!Array.isArray(values)) return [];
  const defaults = {
    provider: result.provider,
    model: result.model,
    requestId: result.requestId ?? result.request_id,
    responseId: result.responseId ?? result.response_id,
  };
  return values.map((value) => {
    const metadata = normalizeModelOutputArtifact(value, defaults);
    const source = artifactSource(value);
    return metadata && source ? { metadata, ...source } : null;
  }).filter(Boolean);
}
