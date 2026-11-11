import { readResponseBytesBounded } from './adapter-primitives.mjs';

// No invented deployment budgets. Enforce a limit only when configured.
function configuredLimit(value) {
  if (value === undefined || value === null) return Infinity;
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('invalid_generated_media_budget');
  return limit;
}

export function mediaBudgets(config = {}) {
  return {
    total: configuredLimit(config.maxDecodedBytes),
    asset: configuredLimit(config.maxAssetBytes ?? config.maxResponseBytes),
    metadata: configuredLimit(config.maxResponseBytes),
    count: configuredLimit(config.maxArtifactCount),
  };
}

export async function mediaBytes(response, limit = Infinity) {
  const result = await readResponseBytesBounded(response, limit);
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

export function decodeMedia(encoded, remaining = Infinity) {
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  const size = Math.floor(encoded.length * 3 / 4) - padding;
  if (size > remaining) throw new Error('generated_media_decoded_too_large');
  return Buffer.from(encoded, 'base64');
}
