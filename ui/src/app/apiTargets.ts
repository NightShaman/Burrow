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
    contributions?: { apiTargets?: unknown };
  }>;
};

type TargetsResponse = { ok: true; targets?: unknown };

export type ApiTargetContribution = {
  modId: string;
  name: string;
  endpoint: string;
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
    return [{ modId: mod.id, name: typeof mod.name === 'string' && mod.name.trim() ? mod.name.trim() : mod.id, endpoint }];
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
