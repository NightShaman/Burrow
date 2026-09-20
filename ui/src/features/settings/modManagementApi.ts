import { api, apiLocal } from '../../app/api';

export type ModRecord = {
  id: string;
  name: string;
  version?: string;
  runningVersion?: string;
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
export type SourceRefreshState = { enabled: boolean; intervalMs?: number; staleMs?: number; refreshing: boolean; failures: number };
export type SourceRefreshConfig = { enabled: boolean; intervalMs: number; staleMs: number };
export type ModManagementState = { ok?: boolean; restartRequired?: boolean; sourceRefresh?: Partial<SourceRefreshState>; mods?: ModRecord[]; sources?: ModSource[] };
export type NormalizedModManagement = { ok?: boolean; restartRequired: boolean; sourceRefresh?: SourceRefreshState; mods: ModRecord[]; sources: ModSource[] };

const defaultSourceRefresh: SourceRefreshState = { enabled: false, refreshing: false, failures: 0 };

export function normalizeModManagement(value: unknown): NormalizedModManagement {
  const body = value && typeof value === 'object' ? value as ModManagementState : {};
  const refresh = body.sourceRefresh && typeof body.sourceRefresh === 'object' ? body.sourceRefresh : {};
  return {
    ok: body.ok,
    restartRequired: body.restartRequired === true,
    sourceRefresh: {
      enabled: refresh.enabled === true,
      ...(typeof refresh.intervalMs === 'number' && Number.isFinite(refresh.intervalMs) ? { intervalMs: refresh.intervalMs } : {}),
      ...(typeof refresh.staleMs === 'number' && Number.isFinite(refresh.staleMs) ? { staleMs: refresh.staleMs } : {}),
      refreshing: refresh.refreshing === true,
      failures: typeof refresh.failures === 'number' && Number.isFinite(refresh.failures) ? refresh.failures : 0,
    },
    mods: Array.isArray(body.mods) ? body.mods.filter((mod): mod is ModRecord => Boolean(mod && typeof mod === 'object' && typeof mod.id === 'string' && typeof mod.name === 'string')) : [],
    sources: Array.isArray(body.sources) ? body.sources.filter((source): source is ModSource => Boolean(source && typeof source === 'object' && typeof source.id === 'string' && typeof source.url === 'string')) : [],
  };
}

export async function loadModManagement(): Promise<NormalizedModManagement> {
  const state = normalizeModManagement(await api<ModManagementState>('/api/mod-management'));
  const catalog = await apiLocal<{ mods?: Array<{ id?: unknown; version?: unknown }> }>('/api/mods').catch(() => ({ mods: [] }));
  const runningVersions = new Map((catalog.mods ?? []).flatMap((mod) => typeof mod.id === 'string' && typeof mod.version === 'string' ? [[mod.id, mod.version] as const] : []));
  return { ...state, mods: state.mods.map((mod) => ({ ...mod, ...(runningVersions.has(mod.id) ? { runningVersion: runningVersions.get(mod.id) } : {}) })) };
}

export async function modManagementAction(path: string, init: RequestInit = {}) {
  return api<ModManagementState>(path, { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } });
}

export async function loadSourceRefreshConfig(): Promise<SourceRefreshConfig> {
  const response = await api<{ sourceRefresh?: Partial<SourceRefreshConfig> }>('/api/mod-management/source-refresh');
  const config = response.sourceRefresh;
  if (!config || typeof config.enabled !== 'boolean' || !Number.isSafeInteger(config.intervalMs) || (config.intervalMs ?? 0) <= 0 || !Number.isSafeInteger(config.staleMs) || (config.staleMs ?? 0) <= 0) {
    throw new Error('Core returned invalid mod source refresh settings.');
  }
  return { enabled: config.enabled, intervalMs: config.intervalMs!, staleMs: config.staleMs! };
}

export async function saveSourceRefreshConfig(config: SourceRefreshConfig): Promise<SourceRefreshConfig> {
  const response = await api<{ sourceRefresh?: Partial<SourceRefreshConfig> }>('/api/mod-management/source-refresh', {
    method: 'PUT',
    body: JSON.stringify(config),
  });
  const saved = response.sourceRefresh;
  if (!saved || typeof saved.enabled !== 'boolean' || !Number.isSafeInteger(saved.intervalMs) || (saved.intervalMs ?? 0) <= 0 || !Number.isSafeInteger(saved.staleMs) || (saved.staleMs ?? 0) <= 0) {
    throw new Error('Core returned invalid saved mod source refresh settings.');
  }
  return { enabled: saved.enabled, intervalMs: saved.intervalMs!, staleMs: saved.staleMs! };
}

export function modLifecyclePath(modId: string, action: 'install' | 'uninstall' | 'enable' | 'disable') {
  return `/api/mod-management/${encodeURIComponent(modId)}/${action}`;
}

export function isModBusyError(value: unknown) {
  const error = value as { status?: unknown; message?: unknown } | null;
  return error?.status === 409 && (error?.message === 'mod_busy' || error?.message === 'mod_install_in_progress');
}

export { defaultSourceRefresh };
