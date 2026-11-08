const METADATA_KEY = 'ui_preferences';
export const UI_PREFERENCE_KEYS = Object.freeze([
  'hc.theme', 'hc.selectedAgentId', 'hc.leftCollapsed', 'hc.rightCollapsed',
  'hc.leftSplit', 'hc.rightSplit', 'hc.leftTopPanel', 'hc.leftBottomPanel',
  'hc.rightTopPanel', 'hc.rightBottomPanel', 'hc.leftRailLayout', 'hc.rightRailLayout',
  'hc.leftSinglePanel', 'hc.rightSinglePanel', 'hc.rightPanelDefaultsVersion',
  'hc.agentRailPreferences', 'hc.groupChatTabs',
  'hc.settingsUtilityPanelOpen', 'hc.accountStatusOrder',
]);
const allowed = new Set(UI_PREFERENCE_KEYS);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const project = value => Object.fromEntries(Object.entries(object(value) ? value : {})
  .filter(([key, entry]) => allowed.has(key) && typeof entry === 'string'));

export async function uiPreferences({ metadata } = {}) {
  if (!metadata?.get) throw new Error('settings_metadata_store_required');
  return { values: project(await metadata.get(METADATA_KEY)) };
}

export async function saveUiPreferences(body, { metadata } = {}) {
  if (!object(body) || Object.keys(body).some(key => !['values', 'seedOnly'].includes(key))
      || !Object.hasOwn(body, 'values') || !object(body.values)
      || (Object.hasOwn(body, 'seedOnly') && typeof body.seedOnly !== 'boolean')
      || Object.entries(body.values).some(([key, value]) => !allowed.has(key) || (value !== null && typeof value !== 'string'))) {
    return { ok: false, status: 400, error: 'invalid_ui_preferences' };
  }
  if (!metadata?.atomicUpdate) throw new Error('settings_metadata_store_required');
  // The shared PostgreSQL metadata boundary serializes even concurrent first writes.
  const values = await metadata.atomicUpdate(METADATA_KEY, current => {
    const next = project(current);
    for (const [key, value] of Object.entries(body.values)) {
      if (body.seedOnly && Object.hasOwn(next, key)) continue;
      if (value === null) delete next[key];
      else next[key] = value;
    }
    return next;
  });
  return { values };
}
