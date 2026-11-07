import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, FocusEvent, SetStateAction } from 'react';
import { isUnsavedChangesModalTarget, useUnsavedChanges } from '../../app/UnsavedChanges';
import {
  loadModManagement,
  loadSourceRefreshConfig,
  saveSourceRefreshConfig,
  type NormalizedModManagement,
  type SourceRefreshConfig,
} from './modManagementApi';

export type DurationUnit = 'hours' | 'minutes' | 'seconds' | 'milliseconds';
type DurationDraft = { value: string; unit: DurationUnit };
export const durationMultipliers: Record<DurationUnit, number> = {
  hours: 3_600_000,
  minutes: 60_000,
  seconds: 1_000,
  milliseconds: 1,
};

function durationDraft(milliseconds: number): DurationDraft {
  for (const unit of ['hours', 'minutes', 'seconds'] as const) {
    const multiplier = durationMultipliers[unit];
    if (milliseconds % multiplier === 0) return { value: String(milliseconds / multiplier), unit };
  }
  return { value: String(milliseconds), unit: 'milliseconds' };
}

function durationMilliseconds(draft: DurationDraft) {
  const value = Number(draft.value);
  const milliseconds = value * durationMultipliers[draft.unit];
  return Number.isFinite(value) && value > 0 && Number.isSafeInteger(milliseconds)
    ? milliseconds
    : null;
}

export function formatDuration(milliseconds: number) {
  const draft = durationDraft(milliseconds);
  return `${draft.value} ${draft.unit}`;
}

export function useAutomaticChecks(
  section: string,
  busy: string | null,
  setBusy: Dispatch<SetStateAction<string | null>>,
  setError: Dispatch<SetStateAction<string | null>>,
  setState: Dispatch<SetStateAction<NormalizedModManagement>>,
) {
  const [refreshConfig, setRefreshConfig] = useState<SourceRefreshConfig | null>(null);
  const [refreshConfigError, setRefreshConfigError] = useState<string | null>(null);
  const [refreshNotice, setRefreshNotice] = useState('');
  const [refreshSaveFailed, setRefreshSaveFailed] = useState(false);
  const refreshSaving = useRef(false);
  const refreshOwner = useRef<object | null>(null);
  const [refreshEnabled, setRefreshEnabled] = useState(false);
  const [refreshInterval, setRefreshInterval] = useState<DurationDraft>({
    value: '',
    unit: 'hours',
  });
  const [refreshStale, setRefreshStale] = useState<DurationDraft>({ value: '', unit: 'minutes' });

  const applyRefreshConfig = useCallback((config: SourceRefreshConfig) => {
    setRefreshConfig(config);
    setRefreshEnabled(config.enabled);
    setRefreshInterval(durationDraft(config.intervalMs));
    setRefreshStale(durationDraft(config.staleMs));
  }, []);

  const loadRefreshConfiguration = useCallback(async () => {
    const ticket = {};
    refreshOwner.current = ticket;
    refreshSaving.current = false;
    setBusy((current) => (current === 'source-refresh-settings' ? null : current));
    setRefreshConfig(null);
    setRefreshConfigError(null);
    setRefreshNotice('');
    setRefreshSaveFailed(false);
    try {
      const config = await loadSourceRefreshConfig();
      if (refreshOwner.current === ticket) applyRefreshConfig(config);
    } catch (cause) {
      if (refreshOwner.current === ticket)
        setRefreshConfigError(
          cause instanceof Error ? cause.message : 'Could not load source refresh settings.',
        );
    }
  }, [applyRefreshConfig]);

  useEffect(() => {
    if (section === 'automatic-checks') void loadRefreshConfiguration();
    else {
      refreshSaving.current = false;
      setBusy((current) => (current === 'source-refresh-settings' ? null : current));
    }
    return () => {
      refreshOwner.current = null;
    };
  }, [section, loadRefreshConfiguration]);
  const refreshDirty =
    !!refreshConfig &&
    (refreshEnabled !== refreshConfig.enabled ||
      durationMilliseconds(refreshInterval) !== refreshConfig.intervalMs ||
      durationMilliseconds(refreshStale) !== refreshConfig.staleMs);

  const clearRefreshFeedback = () => {
    setRefreshConfigError(null);
    setRefreshNotice('');
    setRefreshSaveFailed(false);
  };
  const saveRefreshConfiguration = async (
    draft = { enabled: refreshEnabled, interval: refreshInterval, stale: refreshStale },
  ) => {
    if (!refreshConfig || busy !== null || refreshSaving.current || !refreshOwner.current)
      return false;
    const intervalMs = durationMilliseconds(draft.interval);
    const staleMs = durationMilliseconds(draft.stale);
    if (intervalMs === null || staleMs === null) {
      setRefreshConfigError('Enter positive whole durations that resolve to milliseconds.');
      return false;
    }
    if (
      draft.enabled === refreshConfig.enabled &&
      intervalMs === refreshConfig.intervalMs &&
      staleMs === refreshConfig.staleMs
    ) {
      clearRefreshFeedback();
      return true;
    }
    const ticket = refreshOwner.current;
    refreshSaving.current = true;
    setBusy('source-refresh-settings');
    clearRefreshFeedback();
    try {
      const saved = await saveSourceRefreshConfig({ enabled: draft.enabled, intervalMs, staleMs });
      if (refreshOwner.current !== ticket) return false;
      applyRefreshConfig(saved);
      setRefreshNotice('Automatic source checks saved.');
      // The write is confirmed independently of the catalog reload. A failed
      // reload must not turn a persisted setting back into an unsaved draft.
      try {
        const next = await loadModManagement();
        if (refreshOwner.current === ticket) setState(next);
      } catch {
        if (refreshOwner.current === ticket)
          setError('Automatic source checks saved, but the catalog could not be refreshed.');
      }
      return true;
    } catch (cause) {
      if (refreshOwner.current === ticket) {
        setRefreshConfigError(
          cause instanceof Error ? cause.message : 'Could not save source refresh settings.',
        );
        setRefreshSaveFailed(true);
      }
      return false;
    } finally {
      if (refreshOwner.current === ticket) {
        refreshSaving.current = false;
        setBusy(null);
      }
    }
  };
  // The numeric value and unit are a single editor. Blurring the number
  // into its select must not save/disable the select before its change event.
  const refreshDurationBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (isUnsavedChangesModalTarget(event.relatedTarget)) return;
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))
      return;
    if (refreshDirty) void saveRefreshConfiguration();
  };
  useUnsavedChanges({
    dirty: section === 'automatic-checks' && refreshDirty,
    busy: busy === 'source-refresh-settings',
    resumeAfterAutosave: true,
    save: () => saveRefreshConfiguration(),
    discard: () => {
      if (refreshConfig) applyRefreshConfig(refreshConfig);
      clearRefreshFeedback();
    },
  });

  return {
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
  };
}
