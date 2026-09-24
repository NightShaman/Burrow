import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { modsChangedEvent } from '../../app/modPanels';
import { apiTargetsChangedEvent, modContributionsChangedEvent } from '../../app/apiTargets';
import { Field } from './SettingsPrimitives';
import { defaultSourceRefresh, isModBusyError, loadModManagement, loadSourceRefreshConfig, modLifecyclePath, modManagementAction, saveSourceRefreshConfig, type ModRecord, type ModSource, type NormalizedModManagement, type SourceRefreshConfig } from './modManagementApi';

type ModsSection = 'installed' | 'sources' | 'automatic-checks';
type Props = { section?: ModsSection; overflowTarget?: HTMLElement | null };

function formatCheckedTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleString();
}

function actionLabel(mod: ModRecord) {
  if (mod.status !== 'installed') return 'Install';
  return mod.version && mod.latestVersion && mod.updateAvailable === true ? 'Update' : 'Reinstall';
}

type DurationUnit = 'hours' | 'minutes' | 'seconds' | 'milliseconds';
type DurationDraft = { value: string; unit: DurationUnit };
const durationMultipliers: Record<DurationUnit, number> = { hours: 3_600_000, minutes: 60_000, seconds: 1_000, milliseconds: 1 };

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
  return Number.isFinite(value) && value > 0 && Number.isSafeInteger(milliseconds) ? milliseconds : null;
}

function formatDuration(milliseconds: number) {
  const draft = durationDraft(milliseconds);
  return `${draft.value} ${draft.unit}`;
}

export function ModsSettings({ section = 'installed', overflowTarget }: Props) {
  const [state, setState] = useState<NormalizedModManagement>({ mods: [], sources: [], restartRequired: false, sourceRefresh: defaultSourceRefresh });
  const [selectedModId, setSelectedModId] = useState<string | null>(null);
  const [sourceUrl, setSourceUrl] = useState('');
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [sourceUsername, setSourceUsername] = useState('');
  const sourceSecretRef = useRef<HTMLInputElement>(null);
  // Do not retain the secret in React state or browser storage. Wipe the DOM field on unmount.
  useEffect(() => {
    const input = sourceSecretRef.current;
    return () => { if (input) input.value = ''; };
  }, []);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshConfig, setRefreshConfig] = useState<SourceRefreshConfig | null>(null);
  const [refreshConfigError, setRefreshConfigError] = useState<string | null>(null);
  const [refreshEnabled, setRefreshEnabled] = useState(false);
  const [refreshInterval, setRefreshInterval] = useState<DurationDraft>({ value: '', unit: 'hours' });
  const [refreshStale, setRefreshStale] = useState<DurationDraft>({ value: '', unit: 'minutes' });

  const applyRefreshConfig = useCallback((config: SourceRefreshConfig) => {
    setRefreshConfig(config);
    setRefreshEnabled(config.enabled);
    setRefreshInterval(durationDraft(config.intervalMs));
    setRefreshStale(durationDraft(config.staleMs));
  }, []);

  const loadRefreshConfiguration = useCallback(async () => {
    setRefreshConfigError(null);
    try {
      applyRefreshConfig(await loadSourceRefreshConfig());
    } catch (cause) {
      setRefreshConfigError(cause instanceof Error ? cause.message : 'Could not load source refresh settings.');
    }
  }, [applyRefreshConfig]);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      setState(await loadModManagement());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load mod management.');
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { if (section === 'automatic-checks') void loadRefreshConfiguration(); }, [section, loadRefreshConfiguration]);

  useEffect(() => {
    if (!state.mods.some((mod) => mod.id === selectedModId)) setSelectedModId(state.mods[0]?.id ?? null);
  }, [state.mods, selectedModId]);
  const selectedMod = state.mods.find((mod) => mod.id === selectedModId) ?? null;
  const selectedSource = state.sources.find((source) => source.id === selectedSourceId) ?? null;
  useEffect(() => { if (selectedSourceId && !selectedSource) setSelectedSourceId(null); }, [selectedSourceId, selectedSource]);
  const sourceRefresh = state.sourceRefresh ?? defaultSourceRefresh;

  const run = async (key: string, path: string, init?: RequestInit, onSubmitted?: () => void) => {
    setBusy(key);
    setError(null);
    try {
      const result = await modManagementAction(path, init);
      window.dispatchEvent(new Event(modsChangedEvent));
      window.dispatchEvent(new Event(apiTargetsChangedEvent));
      window.dispatchEvent(new Event(modContributionsChangedEvent));
      onSubmitted?.();
      const next = await loadModManagement();
      setState({ ...next, restartRequired: next.restartRequired || result?.restartRequired === true });
      return true;
    } catch (cause) {
      setError(isModBusyError(cause)
        ? 'This mod is busy with active work. Let that work finish, then try again; Burrow did not cancel it.'
        : key === 'source' ? 'Could not add mod source. Check the URL and credentials.' : cause instanceof Error ? cause.message : 'Mod operation failed.');
      return false;
    } finally {
      setBusy(null);
    }
  };

  const saveRefreshConfiguration = async () => {
    const intervalMs = durationMilliseconds(refreshInterval);
    const staleMs = durationMilliseconds(refreshStale);
    if (intervalMs === null || staleMs === null) {
      setRefreshConfigError('Enter positive whole durations that resolve to milliseconds.');
      return;
    }
    setBusy('source-refresh-settings');
    setRefreshConfigError(null);
    try {
      const saved = await saveSourceRefreshConfig({ enabled: refreshEnabled, intervalMs, staleMs });
      applyRefreshConfig(saved);
      const next = await loadModManagement();
      setState(next);
    } catch (cause) {
      setRefreshConfigError(cause instanceof Error ? cause.message : 'Could not save source refresh settings.');
    } finally {
      setBusy(null);
    }
  };

  const install = (mod: ModRecord) => {
    void run(mod.id, modLifecyclePath(mod.id, 'install'), { method: 'POST', body: JSON.stringify({}) });
  };
  const lifecycle = (mod: ModRecord, action: 'uninstall' | 'enable' | 'disable') => {
    void run(mod.id, modLifecyclePath(mod.id, action), { method: 'POST' });
  };
  const addSource = async () => {
    const url = selectedSource?.url ?? sourceUrl.trim();
    if (!url) return;
    const username = sourceUsername.trim();
    const secret = sourceSecretRef.current?.value ?? '';
    if (username || secret) {
      if (!/^https:\/\/[^/]+/i.test(url)) {
        setError('Private repository credentials are supported only for HTTPS Git URLs. Configure SSH access on the Core service account instead.');
        return;
      }
      if (username && !secret) {
        setError('Enter a password or access token when specifying a private repository username.');
        return;
      }
    }
    const body = JSON.stringify({ url, ...(secret ? { auth: { ...(username ? { username } : {}), token: secret } } : {}) });
    setBusy('source');
    setError(null);
    let submitted = false;
    let discoveryError = false;
    try {
      await modManagementAction('/api/mod-management/sources', { method: 'POST', body });
      submitted = true;
    } catch {
      // Core may retain the source even if discovery failed. Reload before
      // reporting the outcome rather than implying nothing was saved.
      discoveryError = true;
    }
    if (submitted) {
      if (!selectedSource) setSourceUrl('');
      setSourceUsername('');
      if (sourceSecretRef.current) sourceSecretRef.current.value = '';
    }
    try {
      const next = await loadModManagement();
      setState(next);
      if (discoveryError) {
        const retained = next.sources.find((source) => source.url === url);
        setError(retained
          ? `Source saved, but discovery failed. ${retained.error || 'See the configured source status for details.'}`
          : 'Could not add mod source. Check the repository URL and credentials.');
      }
    } catch {
      setError(submitted
        ? 'Source added, but the catalog could not be refreshed. Refresh sources to see its status.'
        : 'Could not confirm whether the source was saved. Catalog refresh failed; check configured sources before retrying.');
    } finally {
      setBusy(null);
    }
  };

  const modInventoryContents = state.mods.length === 0
    ? <p className="settings-empty">No mods found. Add a source in Mod sources.</p>
    : <div className="memory-connection-list">{state.mods.map((mod) => <article className="memory-connection" key={mod.id}>
      <button type="button" className="memory-connection-select" aria-label={`Manage ${mod.name}`} aria-pressed={mod.id === selectedModId} disabled={busy !== null} onClick={() => setSelectedModId(mod.id)}><strong>{mod.name}{mod.system && <span className="mod-system-badge">System</span>}</strong><small>{mod.status === 'installed' ? (mod.enabled ? 'Installed · Enabled' : 'Installed · Disabled') : 'Available'}{mod.version ? ` · Installed ${mod.version}` : ''}{mod.runningVersion ? ` · Running ${mod.runningVersion}` : ''}</small></button>
    </article>)}</div>;
  const modInventory = overflowTarget
    ? <div className="settings-overflow-content memory-saved" aria-label="Mod catalog">{modInventoryContents}</div>
    : <details className="memory-saved saved-accordion" open><summary><h3>Mod catalog</h3><span>{state.mods.length}</span></summary>{modInventoryContents}</details>;

  const modConfiguration = <section className="setting-section mod-configuration" aria-labelledby="selected-mod-heading">
    <h2 id="selected-mod-heading">{selectedMod ? selectedMod.name : 'Mod details'}</h2>
    {selectedMod ? <>
      <p className="settings-description">Manage installation, version, and availability for this mod.</p>
      <Field label="Mod ID"><input value={selectedMod.id} readOnly /></Field>
      <div className="field-pair"><Field label="Installed version"><input value={selectedMod.status === 'installed' ? selectedMod.version || 'Unknown' : 'Not installed'} readOnly /></Field><Field label="Running version"><input value={selectedMod.enabled ? selectedMod.runningVersion || 'Unavailable' : 'Not running'} readOnly /></Field></div>
      <Field label="Latest source version"><input value={selectedMod.latestVersion || 'Unknown'} readOnly /></Field>
      <p className="settings-description">{selectedMod.status === 'installed' ? `Installed · ${selectedMod.enabled ? 'Enabled' : 'Disabled'}` : 'Available from a configured source'}{selectedMod.reason ? ` · ${selectedMod.reason}` : ''}</p>
      <p className="settings-help">Install, update, enable, and disable apply live without restarting Burrow. New installs start disabled; updates and reinstalls preserve the current enabled or disabled state.</p>
      <div className="model-actions">
        {selectedMod.status === 'installed' && <button className="danger" type="button" disabled={busy !== null} onClick={() => lifecycle(selectedMod, 'uninstall')}>{busy === selectedMod.id ? 'Working…' : 'Uninstall'}</button>}
        {selectedMod.status === 'installed' && <button className="secondary" type="button" disabled={busy !== null} onClick={() => lifecycle(selectedMod, selectedMod.enabled ? 'disable' : 'enable')}>{busy === selectedMod.id ? 'Working…' : selectedMod.enabled ? 'Disable' : 'Enable'}</button>}
        <button className={selectedMod.status === 'installed' ? 'secondary' : 'primary'} type="button" disabled={busy !== null || selectedMod.canInstall === false} onClick={() => install(selectedMod)}>{busy === selectedMod.id ? 'Working…' : actionLabel(selectedMod)}</button>
      </div>
    </> : <p className="settings-empty">Select a mod from the catalog to manage it.</p>}
  </section>;

  const sourceInventoryContents = state.sources.length === 0
    ? <p className="settings-empty">No custom sources configured.</p>
    : <div className="memory-connection-list">{state.sources.map((source: ModSource) => <article className="memory-connection" key={source.id}><button type="button" className="memory-connection-select" aria-label={`Edit ${source.url}`} aria-pressed={source.id === selectedSourceId} onClick={() => { const selecting = selectedSourceId !== source.id; setSelectedSourceId(selecting ? source.id : null); setSourceUrl(selecting ? source.url : ''); setSourceUsername(''); if (sourceSecretRef.current) sourceSecretRef.current.value = ''; }}><strong>{source.url}</strong><small>{source.status || 'Unknown'}{source.lastCheckedAt ? ` · Checked ${formatCheckedTime(source.lastCheckedAt)}` : ''}{source.error ? ` · ${source.error}` : ''}</small></button><div className="memory-connection-actions"><button className="danger memory-edit" type="button" disabled={busy !== null} onClick={() => void run(source.id, `/api/mod-management/sources/${encodeURIComponent(source.id)}`, { method: 'DELETE' }, () => { if (source.id === selectedSourceId) { setSelectedSourceId(null); setSourceUrl(''); setSourceUsername(''); if (sourceSecretRef.current) sourceSecretRef.current.value = ''; } })}>Remove</button></div></article>)}</div>;
  const sourceInventory = overflowTarget
    ? <div className="settings-overflow-content memory-saved" aria-label="Configured mod sources">{sourceInventoryContents}</div>
    : <details className="memory-saved saved-accordion" open><summary><h3>Configured sources</h3><span>{state.sources.length}</span></summary>{sourceInventoryContents}</details>;
  const automaticChecks = <section className="setting-section mod-source-configuration" aria-labelledby="source-refresh-settings-heading">
      <h2 id="source-refresh-settings-heading">Automatic source checks</h2>
      {refreshConfigError && <p className="settings-request-error" role="alert">{refreshConfigError}</p>}
      {refreshConfig ? <>
        <label className="agent-enabled"><input type="checkbox" checked={refreshEnabled} disabled={busy !== null} onChange={(event) => setRefreshEnabled(event.target.checked)} /><span>Enable background source checks</span></label>
        <div className="field-pair">
          <Field label="Check every"><div className="field-pair"><input type="number" step="any" value={refreshInterval.value} disabled={busy !== null} onChange={(event) => setRefreshInterval((current) => ({ ...current, value: event.target.value }))} /><select aria-label="Check interval unit" value={refreshInterval.unit} disabled={busy !== null} onChange={(event) => setRefreshInterval((current) => ({ ...current, unit: event.target.value as DurationUnit }))}>{Object.keys(durationMultipliers).map((unit) => <option value={unit} key={unit}>{unit}</option>)}</select></div></Field>
          <Field label="Consider source stale after"><div className="field-pair"><input type="number" step="any" value={refreshStale.value} disabled={busy !== null} onChange={(event) => setRefreshStale((current) => ({ ...current, value: event.target.value }))} /><select aria-label="Stale threshold unit" value={refreshStale.unit} disabled={busy !== null} onChange={(event) => setRefreshStale((current) => ({ ...current, unit: event.target.value as DurationUnit }))}>{Object.keys(durationMultipliers).map((unit) => <option value={unit} key={unit}>{unit}</option>)}</select></div></Field>
        </div>
        <p className="settings-help">Durations are saved exactly in milliseconds. Decimal values are accepted only when they resolve to a whole millisecond.</p>
        <div className="model-actions"><button className="primary" type="button" disabled={busy !== null} onClick={() => void saveRefreshConfiguration()}>{busy === 'source-refresh-settings' ? 'Saving…' : 'Save automatic checks'}</button></div>
      </> : <div className="model-actions"><button className="secondary" type="button" disabled={busy !== null} onClick={() => void loadRefreshConfiguration()}>Retry settings</button></div>}
  </section>;
  const sourceConfiguration = <section className="setting-section mod-source-configuration" aria-labelledby="mod-sources-heading">
    <h2 id="mod-sources-heading">{selectedSource ? 'Selected mod source' : 'Mod sources'}</h2>
    <p className="settings-description">{selectedSource ? 'Recheck this source or replace its HTTPS credentials. The repository URL cannot be changed in place; remove it and add a new source to change the URL.' : 'Add a Git repository URL (HTTP(S), ssh://, or scp-style SSH). Core discovers version-tagged releases containing burrow.mod.json.'}</p>
    <p className="settings-help" role="status">{sourceRefresh.refreshing
      ? 'Checking configured sources now…'
      : sourceRefresh.enabled
        ? `Background source checks are active${sourceRefresh.intervalMs ? ` · every ${formatDuration(sourceRefresh.intervalMs)}` : ''}${sourceRefresh.failures ? ` · ${sourceRefresh.failures} consecutive failed refresh${sourceRefresh.failures === 1 ? '' : 'es'}` : ''}.`
        : 'Background source checks are disabled.'}</p>
    <Field label="Git repository URL"><input value={selectedSource?.url ?? sourceUrl} readOnly={!!selectedSource} onChange={(event) => setSourceUrl(event.target.value)} placeholder="https://git.example.com/team/mod.git" /></Field>
    <Field label="Private repository username (optional)"><input value={sourceUsername} onChange={(event) => setSourceUsername(event.target.value)} autoComplete="off" /></Field>
    <Field label="Password or access token (optional)"><input ref={sourceSecretRef} type="password" autoComplete="new-password" /></Field>
    <p className="settings-help">Public repositories need only a URL. Credentials are for HTTPS Git repositories only and are stored encrypted by Core, not shown here again. For SSH, configure keys and host trust on the Core service account.</p>
    <div className="model-actions"><button className="secondary" type="button" disabled={busy !== null} onClick={() => void run('refresh', '/api/mod-management/refresh', { method: 'POST' })}>{busy === 'refresh' ? 'Refreshing…' : 'Refresh sources'}</button><button className="primary" type="button" disabled={(!selectedSource && !sourceUrl.trim()) || busy !== null} onClick={() => void addSource()}>{busy === 'source' ? (selectedSource ? 'Updating…' : 'Adding…') : selectedSource ? 'Update source' : 'Add source'}</button></div>
  </section>;

  const primary = section === 'installed' ? modConfiguration : section === 'sources' ? sourceConfiguration : automaticChecks;
  const supporting = section === 'installed' ? modInventory : section === 'sources' ? sourceInventory : null;
  return <div className="mod-management-settings">
    {error && <p className="settings-request-error" role="alert">{error}</p>}
    {state.restartRequired && <p className="settings-auth-warning mod-restart-notice" role="status"><strong>Restart required.</strong> This Core reported that the latest mod change still needs a restart.</p>}
    {primary}
    {!overflowTarget && supporting}
    {overflowTarget && supporting && createPortal(supporting, overflowTarget)}
  </div>;
}
