import { googleNativeApi, googleMediaKind, googleVideoSupported } from './google-native-catalog.mjs';
import { isGoogleOpenAICompatible } from './google-wire.mjs';

export const REFERENCE_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const unsupported = () => ({ available: false, reason: 'agent_reference_image_unsupported' });

/** An image input capability alone is not an image-generation/edit contract.
 * OpenAI-compatible media models must declare both image input and image-only
 * output (image or GIF); no model/deployment-name whitelist is imposed. Google's
 * compatible chat endpoint is not implicitly an edits contract; explicit GIF
 * configuration opts into the compatible image contract. Native Google uses the existing
 * documented image-generation contracts, never a guessed model-name substring.
 */
export function referenceImageCapability(config = {}) {
  if (!config) return unsupported();
  const inputs = config.capabilities?.inputs ?? config.acceptedInput;
  const explicitInputs = Array.isArray(inputs);
  const inputFlags = [config.capabilities?.images, config.capabilities?.vision, config.supportsVision, config.vision];
  const declaredInput = explicitInputs || inputFlags.some(value => typeof value === 'boolean');
  const acceptsImages = explicitInputs ? inputs.includes('image') : inputFlags.includes(true);
  if (googleNativeApi(config)) {
    // Native image-generation contracts include image editing. In the absence
    // of an explicit modality list they supply that fact (discovery may only
    // return generation methods); a deliberate input override still wins.
    return (googleMediaKind(config) === 'image' || googleVideoSupported(config)) && (!declaredInput || acceptsImages)
      ? { available: true, reason: null }
      : unsupported();
  }
  const outputs = config.capabilities?.outputs ?? config.acceptedOutput;
  return /^openai-/.test(config.api || config.apiType || '') &&
    Array.isArray(outputs) && (!isGoogleOpenAICompatible(config) || outputs.includes('gif')) && (outputs.includes('image') || outputs.includes('gif')) && !outputs.includes('text') && acceptsImages
    ? { available: true, reason: null }
    : unsupported();
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
