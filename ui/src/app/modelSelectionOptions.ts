import type { SavedProvider } from './types';

export const reasoningEffortsForModel = (provider: SavedProvider | undefined, model: string) =>
  ['off', ...(provider?.modelEfforts?.[model] ?? []).filter(effort => effort !== 'off')];
export const defaultReasoningEffort = (provider: SavedProvider | undefined, model: string) =>
  provider?.defaultEfforts?.[model] ?? provider?.modelEfforts?.[model]?.[0] ?? 'off';
