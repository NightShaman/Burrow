import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { uiPreferenceSync } from './uiPreferences';

/** Authentication must be established before restoring the operator's workspace. */
export function UiPreferencesGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<'loading' | 'ready' | 'error' | 'local'>('loading');
  const [attempt, setAttempt] = useState(0);
  const syncStatus = useSyncExternalStore(uiPreferenceSync.subscribe, uiPreferenceSync.getStatus);
  useEffect(() => {
    let live = true;
    setState('loading');
    void uiPreferenceSync.initialize().then(
      () => {
        if (live) setState('ready');
      },
      () => {
        if (live) setState('error');
      },
    );
    return () => {
      live = false;
    };
  }, [attempt]);

  if (state === 'loading')
    return (
      <div className="preference-loading" role="status">
        Restoring your workspace…
      </div>
    );
  if (state === 'error')
    return (
      <main className="preference-loading">
        <section className="preference-load-error" aria-labelledby="preference-load-title">
          <h1 id="preference-load-title">Couldn't restore your workspace</h1>
          <p role="alert">
            Your saved preferences couldn't be loaded. Your existing settings haven't been changed.
          </p>
          <div className="preference-recovery-actions">
            <button
              className="preference-retry"
              type="button"
              onClick={() => setAttempt((value) => value + 1)}
            >
              Retry
            </button>
            <button className="preference-retry" type="button" onClick={() => setState('local')}>
              Use this browser only
            </button>
          </div>
        </section>
      </main>
    );
  return (
    <>
      {(state === 'local' || syncStatus === 'error') && (
        <div className="preference-sync-error" role="alert">
          {state === 'local'
            ? 'Using browser-only preferences. Changes will not follow you to another PC.'
            : "UI changes haven't synced to Burrow yet."}
          <button
            className="preference-retry"
            type="button"
            onClick={
              state === 'local' ? () => setAttempt((value) => value + 1) : uiPreferenceSync.retry
            }
          >
            Retry
          </button>
        </div>
      )}
      {children}
    </>
  );
}
