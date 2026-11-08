/** Display preferences only. Never include credentials, drafts, or conversation caches. */
export const uiPreferenceKeys = [
  'hc.theme',
  'hc.selectedAgentId',
  'hc.leftCollapsed',
  'hc.rightCollapsed',
  'hc.leftSplit',
  'hc.rightSplit',
  'hc.leftTopPanel',
  'hc.leftBottomPanel',
  'hc.rightTopPanel',
  'hc.rightBottomPanel',
  'hc.leftRailLayout',
  'hc.rightRailLayout',
  'hc.leftSinglePanel',
  'hc.rightSinglePanel',
  'hc.rightPanelDefaultsVersion',
  'hc.agentRailPreferences',
  'hc.groupChatTabs',
  'hc.settingsUtilityPanelOpen',
  'hc.accountStatusOrder',
] as const;

const keys = new Set<string>(uiPreferenceKeys);
export const isUiPreferenceKey = (key: string) => keys.has(key);
