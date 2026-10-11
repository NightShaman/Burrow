// Developer API only. Never reinterpret a Vertex URL or OAuth credential.
export const GOOGLE_NATIVE_API = 'google-generative-language';
export const googleNativeApi = (config = {}) => [GOOGLE_NATIVE_API, 'google-gemini', 'gemini'].includes(config.api || config.apiType);
export function googleNativeBase(config = {}) {
  const url = new URL(config.baseUrl || 'https://generativelanguage.googleapis.com/v1beta');
  if (url.protocol !== 'https:' || url.hostname !== 'generativelanguage.googleapis.com' || url.port || url.username || url.password || url.search || url.hash) throw new Error('google_developer_api_endpoint_unsupported');
  const path = url.pathname.replace(/\/+$/, '').replace(/\/openai$/, '');
  if (!['', '/v1', '/v1beta'].includes(path)) throw new Error('google_developer_api_version_unsupported');
  return `${url.origin}${path || '/v1beta'}`;
}
export function googleNativeHeaders(config = {}) {
  if (config.auth?.type && config.auth.type !== 'api_key') throw new Error('google_developer_api_auth_unsupported');
  const key = config.auth?.token || config.auth?.apiKey || config.apiKey;
  if (!key) throw new Error('google_developer_api_key_required');
  return { 'content-type': 'application/json', 'x-goog-api-key': key };
}
export const googleModelId = value => String(value || '').replace(/^models\//, '');
// Exact documented contracts, not substring inference. Discovery methods alone
// do not describe modalities. Unknown models retain methods, not invented outputs.
export const GOOGLE_IMAGE_MODELS = new Set(['gemini-nano-banana-2.1', 'gemini-2.5-flash-image', 'gemini-3-pro-image', 'gemini-3.1-flash-image', 'gemini-3.1-flash-lite-image']);
export const GOOGLE_MUSIC_MODELS = new Set(['lyria-3-clip-preview', 'lyria-3-pro-preview', 'lyria-3.5']);
export function googleMediaKind(config = {}) {
  try { googleNativeBase(config); } catch { return null; }
  if (config.auth?.type && config.auth.type !== 'api_key') return null;
  const id = googleModelId(config.model);
  if (config.supportedGenerationMethods && !config.supportedGenerationMethods.includes('generateContent') && GOOGLE_IMAGE_MODELS.has(id)) return null;
  const outputs = config.capabilities?.outputs ?? config.acceptedOutput;
  if (Array.isArray(outputs) && !outputs.length) return null;
  if (GOOGLE_MUSIC_MODELS.has(id) && googleNativeBase(config).endsWith('/v1beta') && (!outputs || outputs.includes('audio'))) return 'audio';
  if (googleNativeApi(config) && GOOGLE_IMAGE_MODELS.has(id) && (!outputs || outputs.includes('image'))) return 'image';
  return null;
}
export async function discoverGoogleModels(config, { fetchImpl = fetch, signal } = {}) {
  const base = googleNativeBase(config), headers = googleNativeHeaders(config), models = [], seen = new Set();
  let token = '';
  do {
    if (seen.has(token)) throw new Error('google_model_discovery_pagination_cycle');
    seen.add(token);
    const url = new URL(`${base}/models`);
    if (token) url.searchParams.set('pageToken', token);
    const response = await fetchImpl(url.toString(), { headers, signal });
    if (!response.ok) throw new Error(`model_discovery_failed:${response.status}`);
    const body = await response.json();
    if (!Array.isArray(body.models)) throw new Error('google_model_discovery_invalid');
    for (const m of body.models) {
      if (typeof m.name !== 'string' || !m.name.startsWith('models/')) continue;
      const id = googleModelId(m.name);
      models.push({ id: m.name, displayName: m.displayName, selected: false, manual: false,
        supportedGenerationMethods: Array.isArray(m.supportedGenerationMethods) ? m.supportedGenerationMethods : [],
        googleMetadata: { metadataSource: 'https://ai.google.dev/api/models',
          ...(GOOGLE_IMAGE_MODELS.has(id) ? { outputCapabilitySource: 'https://ai.google.dev/gemini-api/docs/image-generation' } : GOOGLE_MUSIC_MODELS.has(id) ? { outputCapabilitySource: 'https://ai.google.dev/gemini-api/docs/music-generation' } : {}),
          ...Object.fromEntries(['name','baseModelId','version','description','inputTokenLimit','outputTokenLimit','thinking','temperature','maxTemperature','topP','topK'].filter(k => m[k] !== undefined).map(k => [k,m[k]])) },
        discoveredContextWindow: m.inputTokenLimit, outputTokens: m.outputTokenLimit,
        ...(GOOGLE_IMAGE_MODELS.has(id) ? { discoveredOutput: ['text','image'] } : GOOGLE_MUSIC_MODELS.has(id) ? { discoveredOutput: ['audio'] } : {}) });
    }
    token = typeof body.nextPageToken === 'string' ? body.nextPageToken : '';
  } while (token);
  return models;
}
