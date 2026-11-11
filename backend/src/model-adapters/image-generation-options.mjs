import { isGoogleOpenAICompatible } from './google-wire.mjs';

// Keep this allowlist explicit: an image output modality is not evidence of an
// OpenAI Image API parameter contract. New model IDs require documentation.
const GPT_IMAGE = /^gpt-image-(?:1(?:\.5|-mini)?|2|2\.5-(?:sunburst|flare)|2\.6-(?:sunburst|flare))(?:-\d{4}-\d{2}-\d{2})?$/;
const GIF_MODELS = new Set(['gpt-image-2.6-sunburst', 'gpt-image-2.6-flare']);
const STILL_SIZES = ['auto', '1024x1024', '1536x1024', '1024x1536'];
// Convenient frame presets; unpublished aggregate GIF budgets remain provider-owned.
const GIF_SIZES = ['auto', '640x640', '768x512', '512x768'];
export const IMAGE_MAX_PIXELS = 8_294_400;
export const IMAGE_MIN_PIXELS = 655_360;
export const IMAGE_MAX_EDGE = 3840;
const invalid = () => { throw Object.assign(new Error('forge_request_invalid'), { statusCode: 400 }); };
const unsupported = () => { throw Object.assign(new Error('generation_options_unsupported'), { statusCode: 400 }); };

export function imageOptionsCapability(config = {}) {
  if (!config || !/^openai-/.test(config.api || config.apiType || '') || isGoogleOpenAICompatible(config) || !GPT_IMAGE.test(config.model || '')) return null;
  // providerName is an operator-defined display label, not provider identity.
  const provider = String(config.provider || '').toLowerCase();
  if (provider && !['openai', 'azure', 'azure-openai', 'openai-compatible'].includes(provider)) return null;
  const outputs = config.capabilities?.outputs ?? config.acceptedOutput;
  if (Array.isArray(outputs) && (!outputs.includes('image') || outputs.includes('text'))) return null;
  const gif = GIF_MODELS.has(config.model);
  return { outputFormats: gif ? ['png', 'jpeg', 'webp', 'gif'] : ['png', 'jpeg', 'webp'],
    sizes: [...(gif ? GIF_SIZES : STILL_SIZES)],
    ...(gif ? { frameCount: { min: 2, max: 16, default: 9 }, frameDurationMs: { min: 20, max: 2000, step: 10, default: 200 } } : {}) };
}

function dimensions(size, gif = false) {
  if (size === 'auto') return;
  if (typeof size !== 'string' || !/^[1-9]\d*x[1-9]\d*$/.test(size)) invalid();
  const [width, height] = size.split('x').map(Number);
  const pixels = width * height;
  // GIF documentation guarantees positive multiples of 16, but does not publish
  // a numeric aggregate frame budget. Do not invent one from still-image limits.
  // The provider owns model-specific GIF edge/aspect/pixel-budget rejection.
  if (![width, height, pixels].every(Number.isSafeInteger) || width % 16 || height % 16) invalid();
  if (!gif && (Math.max(width, height) > IMAGE_MAX_EDGE || Math.max(width, height) > 3 * Math.min(width, height) ||
      pixels > IMAGE_MAX_PIXELS || pixels < IMAGE_MIN_PIXELS)) invalid();
}

/** Canonical public job identity. Null/omitted means the legacy provider config
 * remains untouched; an explicit object must name its intended output format.
 * validateSupport=false is only for replay comparison before admission. */
export function normalizeImageOptions(value, { config, mode = 'image', validateSupport = true } = {}) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !['outputFormat', 'frameCount', 'frameDurationMs', 'size'].includes(key)) ||
      !['png', 'jpeg', 'webp', 'gif'].includes(value.outputFormat)) invalid();
  if (mode !== 'image') unsupported();
  const gif = value.outputFormat === 'gif';
  const capability = validateSupport ? imageOptionsCapability(config) : null;
  if (validateSupport && !capability?.outputFormats.includes(value.outputFormat)) unsupported();
  if (!gif && ('frameCount' in value || 'frameDurationMs' in value)) invalid();
  if (gif) {
    const frameCount = value.frameCount === undefined ? 9 : value.frameCount;
    const delay = value.frameDurationMs === undefined ? 200 : value.frameDurationMs;
    if (!Number.isInteger(frameCount) || frameCount < 2 || frameCount > 16 ||
        !Number.isInteger(delay) || delay < 20 || delay > 2000) invalid();
    const size = value.size === undefined ? 'auto' : value.size;
    dimensions(size, true);
    return { outputFormat: 'gif', frameCount, frameDurationMs: Math.round(delay / 10) * 10, size };
  }
  const size = value.size === undefined ? 'auto' : value.size;
  dimensions(size);
  if (validateSupport && /^gpt-image-1(?:\.5|-mini)?(?:-|$)/.test(config.model) && !STILL_SIZES.includes(size)) invalid();
  return { outputFormat: value.outputFormat, size };
}

/** Overlay only owned options; never mutate a saved connection or carry still
 * controls into an animation request. Forge requests one animation per job. */
export function withImageOptions(config, imageOptions) {
  if (imageOptions == null) return config;
  const effective = normalizeImageOptions(imageOptions, { config });
  const options = { ...(config.generatedArtifactOptions || {}), output_format: effective.outputFormat, size: effective.size };
  delete options.frame_count;
  delete options.frame_duration_ms;
  if (effective.outputFormat === 'gif') {
    for (const key of ['output_compression', 'compression', 'mask', 'markup', 'stream', 'partial_images', 'response_format', 'background']) delete options[key];
    options.n = 1;
    options.frame_count = effective.frameCount;
    options.frame_duration_ms = effective.frameDurationMs;
  }
  return { ...config, generatedArtifactOptions: options };
}

/** Adapter boundary for configured snake-case options, independently of Forge.
 * The adapter may retain other supported fields after its own allowlist. */
export function validateImageGenerationOptions(config, options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) invalid();
  const copy = { ...options };
  const hasFrames = 'frame_count' in copy || 'frame_duration_ms' in copy;
  if (copy.output_format !== 'gif') {
    if (hasFrames) invalid();
    return copy;
  }
  const effective = normalizeImageOptions({ outputFormat: 'gif',
    ...('frame_count' in copy ? { frameCount: copy.frame_count } : {}),
    ...('frame_duration_ms' in copy ? { frameDurationMs: copy.frame_duration_ms } : {}),
    ...('size' in copy ? { size: copy.size } : {}) }, { config });
  const count = copy.n === undefined ? 1 : copy.n;
  if (!Number.isInteger(count) || count < 1 || count > 10) invalid();
  const clean = withImageOptions({ ...config, generatedArtifactOptions: copy }, effective).generatedArtifactOptions;
  clean.n = count;
  return clean;
}
