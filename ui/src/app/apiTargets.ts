import { useEffect, useMemo, useState } from 'react';
import { apiForTarget, apiLocal } from './api';

export type ApiTarget = {
  id: string;
  name: string;
  baseUrl: string;
  enabled: boolean;
};

export const localApiTarget: ApiTarget = { id: 'local', name: 'Local', baseUrl: '', enabled: true };

export type OwnedResource = {
  targetId: string;
  resourceId: string;
};

type ModsResponse = {
  ok: true;
  mods?: Array<{
    id?: unknown;
    name?: unknown;
    contributions?: { apiTargets?: unknown; settings?: unknown };
  }>;
};

export type ModSettingsEmptyState = { title: string; description?: string };
export type ModSettingsNavigation = { title: string; description?: string };
export type ModSettingsPane = { title: string; description?: string; capability: 'apiTargets' };
export type ModSettingsInventory = ModSettingsPane & { emptyState?: ModSettingsEmptyState };
export type ModSettingsContribution = {
  id: string;
  navigation: ModSettingsNavigation;
  primary: ModSettingsPane;
  inventory?: ModSettingsInventory;
};

function normalizeSettingsContribution(value: unknown): ModSettingsContribution | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const navigation = item.navigation;
  const primary = item.primary;
  if (typeof item.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.id) || !navigation || typeof navigation !== 'object' || !primary || typeof primary !== 'object') return null;
  const nav = navigation as Record<string, unknown>;
  const pane = primary as Record<string, unknown>;
  if (typeof nav.title !== 'string' || !nav.title.trim() || typeof pane.title !== 'string' || !pane.title.trim() || pane.capability !== 'apiTargets') return null;
  const output: ModSettingsContribution = {
    id: item.id,
    navigation: { title: nav.title.trim(), ...(typeof nav.description === 'string' && nav.description.trim() ? { description: nav.description.trim() } : {}) },
    primary: { title: pane.title.trim(), capability: 'apiTargets', ...(typeof pane.description === 'string' && pane.description.trim() ? { description: pane.description.trim() } : {}) },
  };
  if (item.inventory !== undefined) {
    if (!item.inventory || typeof item.inventory !== 'object' || Array.isArray(item.inventory)) return null;
    const inventory = item.inventory as Record<string, unknown>;
    if (typeof inventory.title !== 'string' || !inventory.title.trim() || inventory.capability !== 'apiTargets') return null;
    const emptyState = inventory.emptyState;
    if (emptyState !== undefined && (!emptyState || typeof emptyState !== 'object' || Array.isArray(emptyState))) return null;
    const normalizedEmpty = emptyState as Record<string, unknown> | undefined;
    if (normalizedEmpty && (typeof normalizedEmpty.title !== 'string' || !normalizedEmpty.title.trim())) return null;
    output.inventory = { title: inventory.title.trim(), capability: 'apiTargets', ...(typeof inventory.description === 'string' && inventory.description.trim() ? { description: inventory.description.trim() } : {}), ...(normalizedEmpty ? { emptyState: { title: normalizedEmpty.title as string, ...(typeof normalizedEmpty.description === 'string' && normalizedEmpty.description.trim() ? { description: normalizedEmpty.description.trim() } : {}) } } : {}) };
  }
  return output;
}

type TargetsResponse = { ok: true; targets?: unknown };

export type ApiTargetContribution = {
  modId: string;
  name: string;
  endpoint: string;
  settings?: ModSettingsContribution[];
};

export const apiTargetsChangedEvent = 'burrow:api-targets-changed';

const validTargetId = /^[a-z0-9][a-z0-9._-]*$/i;

export function normalizeApiTarget(value: unknown): ApiTarget | null {
  if (!value || typeof value !== 'object') return null;
  const target = value as Partial<ApiTarget>;
  if (typeof target.id !== 'string' || !validTargetId.test(target.id) || target.id === localApiTarget.id) return null;
  if (typeof target.name !== 'string' || !target.name.trim() || typeof target.baseUrl !== 'string' || typeof target.enabled !== 'boolean') return null;
  try {
    const url = new URL(target.baseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return { id: target.id, name: target.name.trim(), baseUrl: url.toString().replace(/\/$/, ''), enabled: target.enabled };
  } catch {
    return null;
  }
}

function targetsFrom(value: unknown): ApiTarget[] {
  return Array.isArray(value) ? value.map(normalizeApiTarget).filter((target): target is ApiTarget => Boolean(target)) : [];
}

async function loadModsCatalog(): Promise<ModsResponse> {
  return apiLocal<ModsResponse>('/api/mods').catch(() => ({ ok: true as const, mods: [] }));
}

export async function loadApiTargetContributions(): Promise<ApiTargetContribution[]> {
  const catalog = await loadModsCatalog();
  return (catalog.mods ?? []).flatMap((mod) => {
    const endpoint = mod.contributions?.apiTargets;
    if (typeof mod.id !== 'string' || typeof endpoint !== 'string' || !endpoint.startsWith(`/api/mods/${mod.id}/`)) return [];
    const settings = Array.isArray(mod.contributions?.settings)
      ? mod.contributions.settings.map(normalizeSettingsContribution).filter((item): item is ModSettingsContribution => Boolean(item))
      : [];
    return [{ modId: mod.id, name: typeof mod.name === 'string' && mod.name.trim() ? mod.name.trim() : mod.id, endpoint, ...(settings.length ? { settings } : {}) }];
  });
}

export async function loadApiTargets(): Promise<ApiTarget[]> {
  const catalog = await loadModsCatalog();
  const targets: ApiTarget[] = [];
  for (const mod of catalog.mods ?? []) {
    const contribution = mod.contributions?.apiTargets;
    if (Array.isArray(contribution)) {
      targets.push(...targetsFrom(contribution));
      continue;
    }
    if (typeof mod.id === 'string' && typeof contribution === 'string' && contribution.startsWith(`/api/mods/${mod.id}/`)) {
      const response = await apiLocal<TargetsResponse>(contribution).catch(() => ({ ok: true as const, targets: [] }));
      targets.push(...targetsFrom(response.targets));
    }
  }
  return [localApiTarget, ...targets.filter((target, index) => target.enabled && targets.findIndex((item) => item.id === target.id) === index)];
}

export function useApiTargets() {
  const [targets, setTargets] = useState<ApiTarget[]>([localApiTarget]);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const refresh = () => { void loadApiTargets().then((next) => { if (!cancelled) { setTargets(next); setLoaded(true); } }); };
    refresh();
    window.addEventListener(apiTargetsChangedEvent, refresh);
    return () => { cancelled = true; window.removeEventListener(apiTargetsChangedEvent, refresh); };
  }, []);
  return useMemo(() => ({ targets, loaded }), [targets, loaded]);
}

export function ownedResourceId(targetId: string, resourceId: string) {
  return targetId === localApiTarget.id ? resourceId : `${targetId}::${resourceId}`;
}

export function parseOwnedResourceId(id: string): OwnedResource {
  const separator = id.indexOf('::');
  return separator > 0
    ? { targetId: id.slice(0, separator), resourceId: id.slice(separator + 2) }
    : { targetId: localApiTarget.id, resourceId: id };
}

export function targetForResource(targets: ApiTarget[], id: string): { target: ApiTarget; resourceId: string } {
  const owner = parseOwnedResourceId(id);
  return { target: targets.find((target) => target.id === owner.targetId) ?? localApiTarget, resourceId: owner.resourceId };
}

export async function probeTarget(target: ApiTarget): Promise<boolean> {
  try { await apiForTarget(target, '/api/health'); return true; } catch { return false; }
}
