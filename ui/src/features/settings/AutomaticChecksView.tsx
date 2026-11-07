import type { useModsManagement } from './useModsManagement';
import { Field } from './SettingsPrimitives';
import { durationMultipliers, type DurationUnit } from './useAutomaticChecks';

export function AutomaticChecksView({
  model,
}: {
  model: Pick<
    ReturnType<typeof useModsManagement>,
    | 'busy'
    | 'error'
    | 'refreshConfig'
    | 'refreshConfigError'
    | 'refreshNotice'
    | 'refreshSaveFailed'
    | 'refreshEnabled'
    | 'setRefreshEnabled'
    | 'refreshInterval'
    | 'setRefreshInterval'
    | 'refreshStale'
    | 'setRefreshStale'
    | 'refreshDirty'
    | 'clearRefreshFeedback'
    | 'saveRefreshConfiguration'
    | 'loadRefreshConfiguration'
    | 'refreshDurationBlur'
  >;
  overflowTarget?: HTMLElement | null;
}) {
  const {
    busy,
    refreshConfig,
    refreshConfigError,
    refreshNotice,
    refreshSaveFailed,
    refreshEnabled,
    setRefreshEnabled,
    refreshInterval,
    setRefreshInterval,
    refreshStale,
    setRefreshStale,
    refreshDirty,
    clearRefreshFeedback,
    saveRefreshConfiguration,
    loadRefreshConfiguration,
    refreshDurationBlur,
  } = model;
  const automaticChecks = (
    <section
      className="setting-section mod-source-configuration"
      aria-labelledby="source-refresh-settings-heading"
    >
      <h2 id="source-refresh-settings-heading">Automatic source checks</h2>
      {refreshConfigError && (
        <p className="settings-request-error" role="alert">
          {refreshConfigError}
        </p>
      )}
      {refreshConfig ? (
        <>
          <label className="agent-enabled">
            <input
              type="checkbox"
              checked={refreshEnabled}
              disabled={busy !== null}
              onChange={(event) => {
                const enabled = event.target.checked;
                setRefreshEnabled(enabled);
                clearRefreshFeedback();
                void saveRefreshConfiguration({
                  enabled,
                  interval: refreshInterval,
                  stale: refreshStale,
                });
              }}
            />
            <span>Enable background source checks</span>
          </label>
          <div className="field-pair">
            <Field label="Check every">
              <div className="field-pair" onBlur={refreshDurationBlur}>
                <input
                  type="number"
                  step="any"
                  value={refreshInterval.value}
                  disabled={busy !== null}
                  onChange={(event) => {
                    setRefreshInterval((current) => ({ ...current, value: event.target.value }));
                    clearRefreshFeedback();
                  }}
                />
                <select
                  aria-label="Check interval unit"
                  value={refreshInterval.unit}
                  disabled={busy !== null}
                  onChange={(event) => {
                    const interval = {
                      ...refreshInterval,
                      unit: event.target.value as DurationUnit,
                    };
                    setRefreshInterval(interval);
                    clearRefreshFeedback();
                    void saveRefreshConfiguration({
                      enabled: refreshEnabled,
                      interval,
                      stale: refreshStale,
                    });
                  }}
                >
                  {Object.keys(durationMultipliers).map((unit) => (
                    <option value={unit} key={unit}>
                      {unit}
                    </option>
                  ))}
                </select>
              </div>
            </Field>
            <Field label="Consider source stale after">
              <div className="field-pair" onBlur={refreshDurationBlur}>
                <input
                  type="number"
                  step="any"
                  value={refreshStale.value}
                  disabled={busy !== null}
                  onChange={(event) => {
                    setRefreshStale((current) => ({ ...current, value: event.target.value }));
                    clearRefreshFeedback();
                  }}
                />
                <select
                  aria-label="Stale threshold unit"
                  value={refreshStale.unit}
                  disabled={busy !== null}
                  onChange={(event) => {
                    const stale = { ...refreshStale, unit: event.target.value as DurationUnit };
                    setRefreshStale(stale);
                    clearRefreshFeedback();
                    void saveRefreshConfiguration({
                      enabled: refreshEnabled,
                      interval: refreshInterval,
                      stale,
                    });
                  }}
                >
                  {Object.keys(durationMultipliers).map((unit) => (
                    <option value={unit} key={unit}>
                      {unit}
                    </option>
                  ))}
                </select>
              </div>
            </Field>
          </div>
          <p className="settings-help">
            Durations are saved exactly in milliseconds. Decimal values are accepted only when they
            resolve to a whole millisecond.
          </p>
          {busy === 'source-refresh-settings' && (
            <p role="status">Saving automatic source checks…</p>
          )}
          {refreshNotice && <p role="status">{refreshNotice}</p>}
          {refreshSaveFailed && refreshDirty && (
            <button
              className="secondary"
              type="button"
              disabled={busy !== null}
              onClick={() => void saveRefreshConfiguration()}
            >
              Retry saving automatic checks
            </button>
          )}
        </>
      ) : (
        <div className="model-actions">
          <button
            className="secondary"
            type="button"
            disabled={busy !== null}
            onClick={() => void loadRefreshConfiguration()}
          >
            Retry settings
          </button>
        </div>
      )}
    </section>
  );
  return automaticChecks;
}
