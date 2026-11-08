import { api, jsonMutation } from './api';
import {
  readStorage,
  restoreBrowserPreferences,
  subscribeStorageWrites,
  writeStorage,
  removeStorage,
} from './browserStorage';
import { isUiPreferenceKey, uiPreferenceKeys } from './uiPreferenceKeys';

const pendingKey = 'hc.uiPreferencesPending';
const endpoint = '/api/settings/ui-preferences';
type Values = Record<string, string>;
type Patch = Record<string, string | null>;
export type PreferenceSyncStatus = 'saved' | 'saving' | 'error';
type Request = (values?: Patch, seedOnly?: boolean, keepalive?: boolean) => Promise<Values>;

async function request(values?: Patch, seedOnly = false, keepalive = false): Promise<Values> {
  const result = await api<{ values: Values }>(
    endpoint,
    values ? jsonMutation('PATCH', { values, seedOnly }, { keepalive }) : {},
    { deadlineMs: 8000 },
  );
  if (
    !result ||
    !result.values ||
    typeof result.values !== 'object' ||
    Array.isArray(result.values)
  )
    throw new Error('Invalid UI preferences response');
  return Object.fromEntries(
    Object.entries(result.values).filter(
      ([key, value]) => isUiPreferenceKey(key) && typeof value === 'string',
    ),
  );
}

/** Hydrate before mounting preference-owning hooks; never publish mount defaults over saved settings. */
export class UiPreferenceSync {
  private baseline: Values = {};
  private pending: Patch = {};
  private timer: ReturnType<typeof setTimeout> | undefined;
  private writing = false;
  private inFlight: Patch = {};
  private retryDelay = 1000;
  private status: PreferenceSyncStatus = 'saved';
  private listeners = new Set<() => void>();
  private stopWrites?: () => void;
  private initialization?: Promise<void>;

  constructor(private send: Request = request) {}

  getStatus = () => this.status;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private setStatus(status: PreferenceSyncStatus) {
    this.status = status;
    this.listeners.forEach((listener) => listener());
  }

  initialize(): Promise<void> {
    if (this.initialization) return this.initialization;
    this.initialization = this.hydrate().catch((error: unknown) => {
      this.initialization = undefined;
      throw error;
    });
    return this.initialization;
  }

  private async hydrate() {
    const stored = await this.send();
    const seed: Patch = {};
    for (const key of uiPreferenceKeys) {
      const local = readStorage(key);
      if (!(key in stored) && local !== null) seed[key] = local;
    }
    // Atomic insert-if-absent also protects simultaneous first visits from two PCs.
    this.baseline = Object.keys(seed).length ? await this.send(seed, true) : stored;
    // Explicit unsynced edits survive reloads; unlike migration these may replace server values.
    let retained: Patch = {};
    try {
      const parsed: unknown = JSON.parse(readStorage(pendingKey) ?? '{}');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        retained = Object.fromEntries(
          Object.entries(parsed).filter(
            ([key, value]) =>
              isUiPreferenceKey(key) && (typeof value === 'string' || value === null),
          ),
        );
    } catch {
      /* Ignore a malformed local retry journal. */
    }
    if (Object.keys(retained).length) this.baseline = await this.send(retained);
    removeStorage(pendingKey);
    restoreBrowserPreferences(this.baseline);
    this.stopWrites = subscribeStorageWrites((key, value) => {
      const current =
        key in this.pending
          ? this.pending[key]
          : key in this.inFlight
            ? this.inFlight[key]
            : (this.baseline[key] ?? null);
      if (current === value) return;
      this.pending[key] = value;
      this.persistPending();
      this.setStatus('saving');
      this.schedule(250);
    });
    window.addEventListener('online', this.retry);
    window.addEventListener('pagehide', this.onPageHide);
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  private persistPending() {
    const values = { ...this.inFlight, ...this.pending };
    if (Object.keys(values).length) writeStorage(pendingKey, JSON.stringify(values));
    else removeStorage(pendingKey);
  }

  private schedule(delay: number) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.flush();
    }, delay);
  }

  retry = () => {
    void this.flush();
  };
  private onPageHide = () => {
    void this.flush(true);
  };
  private onVisibility = () => {
    if (document.visibilityState === 'hidden') void this.flush(true);
  };

  async flush(keepalive = false) {
    clearTimeout(this.timer);
    if (this.writing || !Object.keys(this.pending).length) return;
    this.writing = true;
    const batch = this.pending;
    this.inFlight = batch;
    this.pending = {};
    try {
      await this.send(batch, false, keepalive);
      for (const [key, value] of Object.entries(batch)) {
        if (value === null) delete this.baseline[key];
        else this.baseline[key] = value;
      }
      this.retryDelay = 1000;
      this.setStatus(Object.keys(this.pending).length ? 'saving' : 'saved');
    } catch {
      // Newer changes win over an older failed request, including deletions.
      this.pending = { ...batch, ...this.pending };
      this.setStatus('error');
      this.schedule(this.retryDelay);
      this.retryDelay = Math.min(this.retryDelay * 2, 30000);
    } finally {
      this.writing = false;
      this.inFlight = {};
      this.persistPending();
      if (this.status !== 'error' && Object.keys(this.pending).length) this.schedule(0);
    }
  }

  dispose() {
    clearTimeout(this.timer);
    this.stopWrites?.();
    window.removeEventListener('online', this.retry);
    window.removeEventListener('pagehide', this.onPageHide);
    document.removeEventListener('visibilitychange', this.onVisibility);
  }
}

export const uiPreferenceSync = new UiPreferenceSync();
