import { api } from '../../app/api';

export type ModRecord = {
  id: string;
  name: string;
  version?: string;
  status?: string;
  system?: boolean;
  enabled?: boolean;
  source?: string;
  latestVersion?: string;
  updateAvailable?: boolean;
  canInstall?: boolean;
  reason?: string;
};

export type ModSource = { id: string; url: string; status?: string; error?: string; lastCheckedAt?: string };
export type ModManagementState = { ok?: boolean; restartRequired?: boolean; mods?: ModRecord[]; sources?: ModSource[] };
export type NormalizedModManagement = { ok?: boolean; restartRequired: boolean; mods: ModRecord[]; sources: ModSource[] };

export function normalizeModManagement(value: unknown): NormalizedModManagement {
  const body = value && typeof value === 'object' ? value as ModManagementState : {};
  return {
    ok: body.ok,
    restartRequired: body.restartRequired === true,
    mods: Array.isArray(body.mods) ? body.mods.filter((mod): mod is ModRecord => Boolean(mod && typeof mod === 'object' && typeof mod.id === 'string' && typeof mod.name === 'string')) : [],
    sources: Array.isArray(body.sources) ? body.sources.filter((source): source is ModSource => Boolean(source && typeof source === 'object' && typeof source.id === 'string' && typeof source.url === 'string')) : [],
  };
}

export async function loadModManagement(): Promise<NormalizedModManagement> {
  return normalizeModManagement(await api<ModManagementState>('/api/mod-management'));
}

export async function modManagementAction(path: string, init: RequestInit = {}) {
  return api<ModManagementState>(path, { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } });
}

export function modLifecyclePath(modId: string, action: 'install' | 'uninstall' | 'enable' | 'disable') {
  return `/api/mod-management/${encodeURIComponent(modId)}/${action}`;
}
