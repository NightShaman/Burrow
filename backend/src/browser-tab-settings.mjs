const METADATA_KEY = 'browser_tab';
const MAX_SUFFIX_LENGTH = 80;

export async function browserTabSettings({ metadata } = {}) {
  if (!metadata?.get) throw new Error('settings_metadata_store_required');
  const stored = await metadata.get(METADATA_KEY);
  return { suffix: typeof stored?.suffix === 'string' ? stored.suffix : '' };
}

export async function saveBrowserTabSettings(body, { metadata } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).length !== 1 || typeof body.suffix !== 'string') {
    return { ok: false, status: 400, error: 'browser_tab_suffix_string_required' };
  }
  const suffix = body.suffix.trim();
  if (Array.from(suffix).length > MAX_SUFFIX_LENGTH) {
    return { ok: false, status: 400, error: 'browser_tab_suffix_too_long' };
  }
  if (!metadata?.set) throw new Error('settings_metadata_store_required');
  await metadata.set(METADATA_KEY, { suffix });
  return { suffix };
}

export const __browserTabSettings__ = Object.freeze({ METADATA_KEY, MAX_SUFFIX_LENGTH });
