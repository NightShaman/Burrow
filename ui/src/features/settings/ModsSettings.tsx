import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { modsChangedEvent } from '../../app/modPanels';
import { modContributionsChangedEvent } from '../../app/apiTargets';
import { Field } from './SettingsPrimitives';
import { defaultSourceRefresh, isModBusyError, loadModManagement, loadSecretReferences, loadSourceRefreshConfig, modLifecyclePath, modManagementAction, saveSourceRefreshConfig, type ModRecord, type ModSource, type NormalizedModManagement, type SecretReference, type SourceRefreshConfig } from './modManagementApi';

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

const compatibleCredentialTypes = new Set(['credential', 'secret', 'token', 'password']);

function sourceIdentity(value: string) {
  try {
    const url = new URL(value);
    return { host: url.hostname.toLowerCase(), owner: url.pathname.split('/').filter(Boolean)[0]?.toLowerCase() ?? '' };
  } catch { return { host: '', owner: '' }; }
}

function credentialText(item: SecretReference) {
  return [item.label, item.type, item.username, item.url, item.service].filter(Boolean).join(' ').toLowerCase();
}

export function rankSecretReferences(items: SecretReference[], query: string, sourceUrl: string, username: string) {
  const terms = query.trim().toLowerCase().split(/\s+/u).filter(Boolean);
  const { host, owner } = sourceIdentity(sourceUrl);
  const expectedUsername = username.trim().toLowerCase();
  return items
    .filter((item) => compatibleCredentialTypes.has(item.type))
    .filter((item) => terms.every((term) => credentialText(item).includes(term)))
    .map((item) => {
      const text = credentialText(item);
      let score = 0;
      if (host && (text.includes(host) || text.includes(host.replace(/^www\./u, '')))) score += 12;
      if (owner && text.includes(owner)) score += 6;
      if (expectedUsername && item.username?.toLowerCase() === expectedUsername) score += 4;
      if (item.type === 'token' || item.type === 'password') score += 2;
      return { item, score };
    })
    .sort((a, b) => b.score - a.score || a.item.label.localeCompare(b.item.label))
    .map(({ item }) => item);
}

export function ModsSettings({ section = 'installed', overflowTarget }: Props) {
  const [state, setState] = useState<NormalizedModManagement>({ mods: [], sources: [], restartRequired: false, sourceRefresh: defaultSourceRefresh });
  const [selectedModId, setSelectedModId] = useState<string | null>(null);
  const [sourceUrl, setSourceUrl] = useState('');
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [sourceUsername, setSourceUsername] = useState('');
  const [secretReferences, setSecretReferences] = useState<SecretReference[]>([]);
  const [selectedSecretReference, setSelectedSecretReference] = useState<SecretReference | null>(null);
  const [secretReferenceError, setSecretReferenceError] = useState<string | null>(null);
  const [credentialPickerOpen, setCredentialPickerOpen] = useState(false);
  const [credentialQuery, setCredentialQuery] = useState('');
  const [activeCredentialIndex, setActiveCredentialIndex] = useState(0);
  const credentialPickerRef = useRef<HTMLDivElement>(null);
  const credentialSearchRef = useRef<HTMLInputElement>(null);
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
  useEffect(() => {
    if (section !== 'sources') return;
    setSecretReferenceError(null);
    void loadSecretReferences().then(setSecretReferences).catch((cause) => {
      setSecretReferences([]);
      setSecretReferenceError(cause instanceof Error ? cause.message : 'Stored credentials are unavailable.');
    });
  }, [section]);
  useEffect(() => { if (section === 'automatic-checks') void loadRefreshConfiguration(); }, [section, loadRefreshConfiguration]);
  useEffect(() => {
    if (!credentialPickerOpen) return;
    const close = (event: PointerEvent) => { if (!credentialPickerRef.current?.contains(event.target as Node)) setCredentialPickerOpen(false); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [credentialPickerOpen]);

  useEffect(() => {
    if (!state.mods.some((mod) => mod.id === selectedModId)) setSelectedModId(state.mods[0]?.id ?? null);
  }, [state.mods, selectedModId]);
  const selectedMod = state.mods.find((mod) => mod.id === selectedModId) ?? null;
  const selectedSource = state.sources.find((source) => source.id === selectedSourceId) ?? null;
  useEffect(() => { if (selectedSourceId && !selectedSource) setSelectedSourceId(null); }, [selectedSourceId, selectedSource]);
  const sourceRefresh = state.sourceRefresh ?? defaultSourceRefresh;
  const rankedSecretReferences = useMemo(() => rankSecretReferences(
    secretReferences,
    credentialQuery,
    selectedSource?.url ?? sourceUrl,
    sourceUsername,
  ), [credentialQuery, secretReferences, selectedSource?.url, sourceUrl, sourceUsername]);
  const visibleSecretReferences = rankedSecretReferences.slice(0, 100);
  useEffect(() => { setActiveCredentialIndex(0); }, [credentialQuery, sourceUrl, sourceUsername]);

  const chooseSecretReference = (item: SecretReference) => {
    setSelectedSecretReference(item);
    if (!sourceUsername && item.username) setSourceUsername(item.username);
    if (sourceSecretRef.current) sourceSecretRef.current.value = '';
    setCredentialPickerOpen(false);
    setCredentialQuery('');
  };
  const openCredentialPicker = (focusSearch = true) => {
    setCredentialPickerOpen(true);
    if (focusSearch) window.setTimeout(() => credentialSearchRef.current?.focus(), 0);
  };
  const credentialPickerKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); setCredentialPickerOpen(false); sourceSecretRef.current?.focus(); return; }
    if (!visibleSecretReferences.length) return;
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      setActiveCredentialIndex((index) => event.key === 'Home' ? 0 : event.key === 'End' ? visibleSecretReferences.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + visibleSecretReferences.length) % visibleSecretReferences.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      chooseSecretReference(visibleSecretReferences[activeCredentialIndex]);
    }
  };

  const run = async (key: string, path: string, init?: RequestInit, onSubmitted?: () => void) => {
    setBusy(key);
    setError(null);
    try {
      const result = await modManagementAction(path, init);
      window.dispatchEvent(new Event(modsChangedEvent));
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
  const removeStoredCredential = async () => {
    if (!selectedSource?.credential?.configured) return;
    setBusy('source-credential');
    setError(null);
    try {
      await modManagementAction(`/api/mod-management/sources/${encodeURIComponent(selectedSource.id)}/credential`, { method: 'DELETE' });
      setSelectedSecretReference(null);
      setSourceUsername('');
      if (sourceSecretRef.current) sourceSecretRef.current.value = '';
      setState(await loadModManagement());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not remove the stored credential.');
    } finally {
      setBusy(null);
    }
  };

  const addSource = async () => {
    const url = selectedSource?.url ?? sourceUrl.trim();
    if (!url) return;
    const username = sourceUsername.trim();
    const secret = sourceSecretRef.current?.value ?? '';
    const credential = secret || selectedSecretReference?.reference || '';
    const resolvedUsername = username || selectedSecretReference?.username || '';
    if (resolvedUsername || credential) {
      if (!/^https:\/\/[^/]+/i.test(url)) {
        setError('Private repository credentials are supported only for HTTPS Git URLs. Configure SSH access on the Core service account instead.');
        return;
      }
      if (resolvedUsername && !credential) {
        setError('Enter a password or access token when specifying a private repository username.');
        return;
      }
    }
    const body = JSON.stringify({ url, ...(credential ? { auth: { ...(resolvedUsername ? { username: resolvedUsername } : {}), token: credential } } : {}) });
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
      setSelectedSecretReference(null);
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
      <button type="button" className="memory-connection-select" aria-label={`Manage ${mod.name}`} aria-pressed={mod.id === selectedModId} disabled={busy !== null} onClick={() => setSelectedModId(mod.id)}><strong>{mod.name}{mod.system && <span className="mod-system-badge">System</span>}</strong><small>{mod.status === 'installed' ? (mod.enabled ? 'Installed · Enabled' : 'Installed · Disabled') : 'Available'}{mod.version ? ` · Installed ${mod.version}` : ''}{mod.runningVersion ? ` · Running ${mod.runningVersion}` : ''}{mod.managedSkillVersion ? ` · Managed skill ${mod.managedSkillVersion}` : ''}</small></button>
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
      <p className="settings-help">Install, update, enable, and disable apply live without restarting Burrow. All mods, including Node Goblin and system mods, start disabled until you explicitly enable them in Settings → Mods → Installed mods. Updates and reinstalls preserve the current enabled or disabled state.</p>
      {selectedMod.status === 'installed' && selectedMod.enabled === false && <p className="settings-help">This mod is disabled. Choose Enable to activate it; installation alone does not enable it.</p>}
      <div className="model-actions">
        {selectedMod.status === 'installed' && <button className="danger" type="button" disabled={busy !== null} onClick={() => lifecycle(selectedMod, 'uninstall')}>{busy === selectedMod.id ? 'Working…' : 'Uninstall'}</button>}
        {selectedMod.status === 'installed' && <button className="secondary" type="button" disabled={busy !== null} onClick={() => lifecycle(selectedMod, selectedMod.enabled ? 'disable' : 'enable')}>{busy === selectedMod.id ? 'Working…' : selectedMod.enabled ? 'Disable' : 'Enable'}</button>}
        <button className={selectedMod.status === 'installed' ? 'secondary' : 'primary'} type="button" disabled={busy !== null || selectedMod.canInstall === false} onClick={() => install(selectedMod)}>{busy === selectedMod.id ? 'Working…' : actionLabel(selectedMod)}</button>
      </div>
    </> : <p className="settings-empty">Select a mod from the catalog to manage it.</p>}
  </section>;

  const sourceInventoryContents = state.sources.length === 0
    ? <p className="settings-empty">No custom sources configured.</p>
    : <div className="memory-connection-list">{state.sources.map((source: ModSource) => <article className="memory-connection" key={source.id}><button type="button" className="memory-connection-select" aria-label={`Edit ${source.url}`} aria-pressed={source.id === selectedSourceId} onClick={() => { const selecting = selectedSourceId !== source.id; setSelectedSourceId(selecting ? source.id : null); setSourceUrl(selecting ? source.url : ''); setSourceUsername(''); setSelectedSecretReference(null); setCredentialPickerOpen(false); if (sourceSecretRef.current) sourceSecretRef.current.value = ''; }}><strong>{source.url}</strong><small>{source.status || 'Unknown'}{source.lastCheckedAt ? ` · Checked ${formatCheckedTime(source.lastCheckedAt)}` : ''}{source.error ? ` · ${source.error}` : ''}</small></button><div className="memory-connection-actions"><button className="danger memory-edit" type="button" disabled={busy !== null} onClick={() => void run(source.id, `/api/mod-management/sources/${encodeURIComponent(source.id)}`, { method: 'DELETE' }, () => { if (source.id === selectedSourceId) { setSelectedSourceId(null); setSourceUrl(''); setSourceUsername(''); if (sourceSecretRef.current) sourceSecretRef.current.value = ''; } })}>Remove</button></div></article>)}</div>;
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
    {selectedSource?.credential?.configured && !selectedSecretReference && <div className="credential-configured" role="status">
      <span className="credential-configured-icon" aria-hidden="true">🔒</span>
      <span><strong>Stored credential configured</strong><small>Leave the password or token empty to keep using it.</small></span>
      <button className="danger" type="button" aria-label="Remove stored credential" disabled={busy !== null} onClick={() => void removeStoredCredential()}>{busy === 'source-credential' ? 'Removing…' : 'Remove'}</button>
    </div>}
    <div className="credential-picker" ref={credentialPickerRef}>
      <div className="field"><label htmlFor="mod-source-secret">Password or access token (optional)</label><div className="credential-entry"><input id="mod-source-secret" ref={sourceSecretRef} type="password" autoComplete="new-password" placeholder={selectedSecretReference ? 'Stored credential selected' : "Paste a credential or type {{gss:…}}"} aria-haspopup={secretReferences.length ? 'listbox' : undefined} aria-expanded={secretReferences.length ? credentialPickerOpen : undefined} aria-controls={credentialPickerOpen ? 'mod-source-credentials' : undefined} onChange={(event) => { const exact = secretReferences.find(item => item.reference === event.target.value) || null; setSelectedSecretReference(exact); if (event.target.value === '{{' && secretReferences.length) openCredentialPicker(); }} />{secretReferences.length > 0 && <button className="credential-browse" type="button" disabled={busy !== null} aria-label="Browse stored credentials" aria-expanded={credentialPickerOpen} aria-controls="mod-source-credentials" onClick={() => credentialPickerOpen ? setCredentialPickerOpen(false) : openCredentialPicker()}>Browse</button>}</div></div>
      {selectedSecretReference && <div className="credential-selection" role="status" title={selectedSecretReference.reference}><span aria-hidden="true">🔒</span><span><strong>{selectedSecretReference.label}</strong><small>{[selectedSecretReference.service, selectedSecretReference.username].filter(Boolean).join(' · ') || 'Stored credential'}</small></span><button type="button" aria-label={`Clear ${selectedSecretReference.label}`} onClick={() => { setSelectedSecretReference(null); sourceSecretRef.current?.focus(); }}>×</button></div>}
      {credentialPickerOpen && <div className="credential-picker-panel">
        <input ref={credentialSearchRef} className="credential-search" type="search" role="combobox" aria-label="Search stored credentials" aria-autocomplete="list" aria-expanded="true" aria-controls="mod-source-credentials" aria-activedescendant={visibleSecretReferences.length ? `mod-source-credential-${activeCredentialIndex}` : undefined} value={credentialQuery} onChange={(event) => setCredentialQuery(event.target.value)} onKeyDown={credentialPickerKeyDown} placeholder="Search credentials" />
        <div id="mod-source-credentials" className="credential-options" role="listbox" aria-label="Stored credentials">
          {visibleSecretReferences.map((item, index) => <button type="button" role="option" id={`mod-source-credential-${index}`} aria-selected={selectedSecretReference?.reference === item.reference} className={activeCredentialIndex === index ? 'active' : ''} key={item.reference} onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => setActiveCredentialIndex(index)} onClick={() => chooseSecretReference(item)}><span aria-hidden="true">🔒</span><span><strong>{item.label}</strong><small>{[item.service, item.username, item.type].filter(Boolean).join(' · ')}</small></span></button>)}
          {visibleSecretReferences.length === 0 && <p className="credential-empty">No compatible credentials match.</p>}
        </div>
        {rankedSecretReferences.length > visibleSecretReferences.length && <p className="credential-limit">Showing 100 of {rankedSecretReferences.length}. Refine your search.</p>}
      </div>}
    </div>
    {secretReferenceError && <p className="settings-help">Stored credentials unavailable. You can still paste a credential or enter a secret reference.</p>}
    <p className="settings-help">Public repositories need only a URL. Credentials are for HTTPS Git repositories only. Stored-secret references are resolved only by Core; the browser never receives their values. For SSH, configure keys and host trust on the Core service account.</p>
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
