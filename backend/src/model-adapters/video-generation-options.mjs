import { forgeMediaContract } from './forge-media-contract.mjs';

const ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9', '5:2'];
const RESOLUTIONS = ['480p', '720p', '1080p'];
const WORKFLOWS = ['text-to-video', 'image-to-video', 'reference-to-video'];
const OPTION_KEYS = ['workflow', 'durationSeconds', 'aspectRatio', 'resolution'];
const invalid = () => { throw Object.assign(new Error('forge_request_invalid'), { statusCode: 400 }); };
const unsupported = () => { throw Object.assign(new Error('generation_options_unsupported'), { statusCode: 400 }); };

/** Only xAI's documented video generation wire owns these controls. Native
 * Google Interactions video keeps its existing provider-selected settings.
 * Defaults describe the UI, not fields to inject into a saved job or request.
 * https://docs.x.ai/developers/model-capabilities/video/overview
 * https://docs.x.ai/developers/model-capabilities/video/generation
 */
export function videoOptionsCapability(config = {}) {
  const contract = forgeMediaContract(config);
  if (contract?.id !== 'xai-video') return null;
  const lite = config.model === 'grok-imagine-video-1.5-lite';
  const legacy = config.model === 'grok-imagine-video';
  const resolutions = legacy ? RESOLUTIONS.slice(0, 2) : [...RESOLUTIONS];
  function workflow(id, minImages, maxImages, maxDuration = 15) {
    const image = id === 'image-to-video';
    return { id, minImages, maxImages, durationSeconds: { min: 1, max: maxDuration, default: 8 },
      aspectRatios: image ? [] : [...ASPECT_RATIOS],
      resolutions: id === 'reference-to-video' ? RESOLUTIONS.slice(0, 2) : [...resolutions],
      defaults: { ...(image ? {} : { aspectRatio: '16:9' }), resolution: '480p' } };
  }
  return { defaultWorkflow: 'text-to-video', defaultReferenceWorkflow: lite ? 'image-to-video' : 'reference-to-video',
    workflows: [workflow('text-to-video', 0, 0), ...(contract.referenceImages ? [
      workflow('image-to-video', 1, 1),
      ...(!lite ? [workflow('reference-to-video', 1, contract.referenceImageLimit, legacy ? 10 : 15)] : []),
    ] : [])] };
}

function requestWorkflow(capability, options, referenceCount) {
  if (!capability) {
    if (options) unsupported();
    return null;
  }
  if (referenceCount !== undefined && (!Number.isSafeInteger(referenceCount) || referenceCount < 0)) unsupported();
  const id = options?.workflow ?? (referenceCount > 0 ? capability.defaultReferenceWorkflow : capability.defaultWorkflow);
  const workflow = capability.workflows.find(item => item.id === id);
  if (!workflow || (referenceCount !== undefined && (referenceCount < workflow.minImages || referenceCount > workflow.maxImages))
    || (options?.durationSeconds !== undefined && (options.durationSeconds < workflow.durationSeconds.min || options.durationSeconds > workflow.durationSeconds.max))
    || (options?.aspectRatio !== undefined && !workflow.aspectRatios.includes(options.aspectRatio))
    || (options?.resolution !== undefined && !workflow.resolutions.includes(options.resolution))) unsupported();
  return workflow;
}

/** Canonical explicit job options. Preserve omission rather than materializing
 * provider defaults or an inferred workflow. validateSupport=false is syntax
 * only, for replay identity before the current model/count is admitted.
 * Without a count, explicit workflows are checked but image bounds are deferred.
 */
export function normalizeVideoOptions(value, { mode = 'video', validateSupport = true, config, capability, referenceCount } = {}) {
  let options = null;
  if (value != null) {
    if (typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
      || Reflect.ownKeys(value).some(key => !OPTION_KEYS.includes(key))) invalid();
    options = {};
    for (const key of OPTION_KEYS) {
      if (!Object.hasOwn(value, key)) continue;
      const item = value[key];
      if ((key === 'workflow' && !WORKFLOWS.includes(item))
        || (key === 'durationSeconds' && (!Number.isInteger(item) || item < 1 || item > 15))
        || (key === 'aspectRatio' && !ASPECT_RATIOS.includes(item))
        || (key === 'resolution' && !RESOLUTIONS.includes(item))) invalid();
      options[key] = item;
    }
    if (!Object.keys(options).length) options = null;
  }
  if (options && mode !== 'video') unsupported();
  if (validateSupport && mode === 'video') requestWorkflow(capability === undefined ? videoOptionsCapability(config) : capability, options, referenceCount);
  return options;
}

/** Recheck current support at admission and at the adapter boundary, including
 * the inferred workflow for requests with no explicit options. Google with no
 * options is unchanged and returns null instead of an xAI workflow record.
 */
export function validateVideoRequest(config, videoOptions, referenceCount = 0) {
  const capability = videoOptionsCapability(config);
  const options = normalizeVideoOptions(videoOptions, { config, capability, referenceCount });
  if (!capability && forgeMediaContract(config)?.id !== 'google-video') unsupported();
  return requestWorkflow(capability, options, referenceCount);
}

/** This config property is owned solely by video; never read or write generic
 * generatedArtifactOptions, and never mutate the saved connection or options.
 */
export function withVideoOptions(config, videoOptions) {
  const options = normalizeVideoOptions(videoOptions, { config });
  return options ? { ...config, forgeVideoOptions: options } : config;
}
