import { apiLocal } from './api';


type ModsResponse = {
  ok: true;
  mods?: Array<{
    id?: unknown;
    name?: unknown;
    version?: unknown;
    contributions?: { settings?: unknown };
    ui?: { settingsUrl?: unknown };
  }>;
};

export type ModSettingsNavigation = { title: string; description?: string };
export type ModSettingsPane = { title: string; description?: string; capability: 'settingsUi' };
export type ModSettingsContribution = {
  id: string;
  navigation: ModSettingsNavigation;
  primary: ModSettingsPane;
};

function normalizeSettingsContribution(value: unknown): ModSettingsContribution | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const navigation = item.navigation;
  const primary = item.primary;
  if (typeof item.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.id) || !navigation || typeof navigation !== 'object' || !primary || typeof primary !== 'object') return null;
  const nav = navigation as Record<string, unknown>;
  const pane = primary as Record<string, unknown>;
  if (typeof nav.title !== 'string' || !nav.title.trim() || typeof pane.title !== 'string' || !pane.title.trim() || pane.capability !== 'settingsUi') return null;
  const output: ModSettingsContribution = {
    id: item.id,
    navigation: { title: nav.title.trim(), ...(typeof nav.description === 'string' && nav.description.trim() ? { description: nav.description.trim() } : {}) },
    primary: { title: pane.title.trim(), capability: pane.capability, ...(typeof pane.description === 'string' && pane.description.trim() ? { description: pane.description.trim() } : {}) },
  };
  return output;
}

export type ModContribution = {
  modId: string;
  name: string;
  settingsUrl?: string;
  version?: string;
  settings?: ModSettingsContribution[];
};

export const modContributionsChangedEvent = 'burrow:mod-contributions-changed';

async function loadModsCatalog(): Promise<ModsResponse> {
  return apiLocal<ModsResponse>('/api/mods').catch(() => ({ ok: true as const, mods: [] }));
}

export async function loadModSettingsContributions(): Promise<ModContribution[]> {
  const catalog = await loadModsCatalog();
  return (catalog.mods ?? []).flatMap((mod) => {
    const settingsUrl = mod.ui?.settingsUrl;
    if (typeof mod.id !== 'string') return [];
    const validSettingsUrl = typeof settingsUrl === 'string' && settingsUrl.startsWith(`/api/mods/${mod.id}/`) ? settingsUrl : undefined;
    const settings = Array.isArray(mod.contributions?.settings)
      ? mod.contributions.settings.map(normalizeSettingsContribution).filter((item): item is ModSettingsContribution => Boolean(item))
      : [];
    if (!validSettingsUrl && !settings.length) return [];
    return [{ modId: mod.id, name: typeof mod.name === 'string' && mod.name.trim() ? mod.name.trim() : mod.id, ...(typeof mod.version === 'string' ? { version: mod.version } : {}), ...(validSettingsUrl ? { settingsUrl: validSettingsUrl } : {}), ...(settings.length ? { settings } : {}) }];
  });
}
