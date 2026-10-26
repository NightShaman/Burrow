export const COMPLETION_WEBHOOK_PATH = '/api/events/github';
const invalid = () => { throw new Error('completion_event_invalid_settings'); };

export function normalizeCompletionEventSettingsPatch(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).some(key => !['deliveryUrl', 'secret', 'clearSecret'].includes(key))) invalid();
  const patch = {};
  if (Object.hasOwn(body, 'deliveryUrl')) {
    if (typeof body.deliveryUrl !== 'string' || body.deliveryUrl.length > 4096) invalid();
    const value = body.deliveryUrl.trim();
    if (value) {
      let url;
      try { url = new URL(value); } catch { invalid(); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || value.includes('?') || value.includes('#') || url.pathname !== COMPLETION_WEBHOOK_PATH) invalid();
    }
    patch.deliveryUrl = value;
  }
  if (Object.hasOwn(body, 'clearSecret') && typeof body.clearSecret !== 'boolean') invalid();
  if (Object.hasOwn(body, 'secret')) {
    if (typeof body.secret !== 'string' || Buffer.byteLength(body.secret, 'utf8') > 8192 || /[\r\n\0]/.test(body.secret)) invalid();
    // Blank fields are preserve markers; nonblank credentials retain exact bytes.
    if (body.secret.trim()) patch.secret = body.secret;
  }
  if (body.clearSecret === true) {
    if (patch.secret !== undefined) invalid();
    patch.clearSecret = true;
  }
  return patch;
}

export function createCompletionEventSettings({ store, env = process.env } = {}) {
  const override = () => typeof env.BURROW_GITHUB_WEBHOOK_SECRET === 'string' && env.BURROW_GITHUB_WEBHOOK_SECRET.length > 0
    ? env.BURROW_GITHUB_WEBHOOK_SECRET : null;
  return {
    async read() {
      const stored = await store.read();
      const environmentOverride = override() !== null;
      const secretSource = environmentOverride ? 'environment' : stored.secretConfigured ? 'settings' : 'none';
      const secretConfigured = environmentOverride || stored.secretConfigured;
      const unavailable = !environmentOverride && stored.secretUnavailable;
      const ready = secretConfigured && !unavailable;
      return { deliveryUrl: stored.deliveryUrl, webhookPath: COMPLETION_WEBHOOK_PATH,
        secretConfigured, storedSecretConfigured: stored.secretConfigured, secretSource,
        environmentOverride, ready, readiness: unavailable ? 'secret_unavailable' : ready ? 'ready' : 'secret_missing' };
    },
    async save(body) {
      await store.write(normalizeCompletionEventSettingsPatch(body));
      return this.read();
    },
    async secret() {
      // A configured environment override remains optional, explicit, and higher priority.
      const value = override();
      if (value !== null) return value;
      const stored = await store.read();
      if (stored.secretUnavailable) throw new Error('completion_event_secret_unavailable');
      return stored.secret;
    },
  };
}
