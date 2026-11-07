import { useInstalledMods } from './useInstalledMods';
import { useSourcesCredentials } from './useSourcesCredentials';
export { rankSecretReferences } from './useSourcesCredentials';
import { useCallback, useEffect, useState } from 'react';
import { modsChangedEvent } from '../../app/modPanels';
import { modContributionsChangedEvent } from '../../app/apiTargets';
import { useAutomaticChecks } from './useAutomaticChecks';
import {
  defaultSourceRefresh,
  isModBusyError,
  loadModManagement,
  modManagementAction,
  type NormalizedModManagement,
} from './modManagementApi';

// One mounted settings lifetime owns the catalog, transaction feedback, selections and
// source draft (including its DOM-only secret). Section switches must not remount it.
export function useModsManagement(section: 'installed' | 'sources' | 'automatic-checks') {
  const [state, setState] = useState<NormalizedModManagement>({
    mods: [],
    sources: [],
    restartRequired: false,
    sourceRefresh: defaultSourceRefresh,
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    setError(null);
    try {
      setState(await loadModManagement());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load mod management.');
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const sources = useSourcesCredentials(section, state, setState, setBusy, setError);
  const sourceRefresh = state.sourceRefresh ?? defaultSourceRefresh;
  const run = async (key: string, path: string, init?: RequestInit, onSubmitted?: () => void) => {
    setBusy(key);
    setError(null);
    try {
      const result = await modManagementAction(path, init);
      window.dispatchEvent(new Event(modsChangedEvent));
      window.dispatchEvent(new Event(modContributionsChangedEvent));
      onSubmitted?.();
      const next = await loadModManagement();
      setState({
        ...next,
        restartRequired: next.restartRequired || result?.restartRequired === true,
      });
      return true;
    } catch (cause) {
      setError(
        isModBusyError(cause)
          ? 'This mod is busy with active work. Let that work finish, then try again; Burrow did not cancel it.'
          : key === 'source'
            ? 'Could not add mod source. Check the URL and credentials.'
            : cause instanceof Error
              ? cause.message
              : 'Mod operation failed.',
      );
      return false;
    } finally {
      setBusy(null);
    }
  };

  const installed = useInstalledMods(state.mods, run);
  const {
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
  } = useAutomaticChecks(section, busy, setBusy, setError, setState);

  return {
    ...sources,
    ...installed,
    state,
    busy,
    error,
    sourceRefresh,
    run,
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
