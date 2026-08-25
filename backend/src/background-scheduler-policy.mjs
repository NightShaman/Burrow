export function backgroundSchedulersEnabled(env = process.env) {
  return !['1', 'true', 'yes', 'on'].includes(String(env.BURROW_DISABLE_BACKGROUND_SCHEDULERS || '').trim().toLowerCase());
}
