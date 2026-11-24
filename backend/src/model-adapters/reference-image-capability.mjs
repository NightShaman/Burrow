import { forgeMediaContract } from './forge-media-contract.mjs';

export const REFERENCE_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const unsupported = () => ({ available: false, reason: 'agent_reference_image_unsupported' });

/** Reference support belongs to the selected provider generation contract,
 * not chat vision or a media output modality by itself. */
export function referenceImageCapability(config = {}) {
  return forgeMediaContract(config)?.referenceImages
    ? { available: true, reason: null } : unsupported();
}

/** Private adapter input only: never accept source URLs or silently ignore an
 * invalid/unsupported image. The managed portrait limit also bounds encoding.
 */
export function validatedSourceImages(value) {
  if (value === undefined) return null;
  if (!Array.isArray(value) || !value.length) throw new Error('source_images_invalid');
  return value.map(image => {
    if (!Buffer.isBuffer(image?.bytes) || !image.bytes.length || image.bytes.length > REFERENCE_IMAGE_MAX_BYTES || !IMAGE_TYPES.has(image.mimeType)) {
      throw new Error('source_images_invalid');
    }
    const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[image.mimeType];
    return { bytes: image.bytes, mimeType: image.mimeType, name: typeof image.name === 'string' && image.name.trim() ? image.name : `reference.${extension}` };
  });
}
