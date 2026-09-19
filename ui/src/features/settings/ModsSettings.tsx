import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { modsChangedEvent } from '../../app/modPanels';
import { Field } from './SettingsPrimitives';
import { loadModManagement, modLifecyclePath, modManagementAction, type ModRecord, type ModSource, type NormalizedModManagement } from './modManagementApi';

type ModsSection = 'installed' | 'sources';
type Props = { section?: ModsSection; overflowTarget?: HTMLElement | null };

function formatCheckedTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleString();
}

function actionLabel(mod: ModRecord) {
  if (mod.status !== 'installed') return 'Install';
  return mod.version && mod.latestVersion && mod.updateAvailable === true ? 'Update' : 'Reinstall';
}

export function ModsSettings({ section = 'installed', overflowTarget }: Props) {
  const [state, setState] = useState<NormalizedModManagement>({ mods: [], sources: [], restartRequired: false });
  const [selectedModId, setSelectedModId] = useState<string | null>(null);
  const [sourceUrl, setSourceUrl] = useState('');
  const [sourceUsername, setSourceUsername] = useState('');
  const sourceSecretRef = useRef<HTMLInputElement>(null);
  // Do not retain the secret in React state or browser storage. Wipe the DOM field on unmount.
  useEffect(() => {
    const input = sourceSecretRef.current;
    return () => { if (input) input.value = ''; };
  }, []);
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
  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    if (!state.mods.some((mod) => mod.id === selectedModId)) setSelectedModId(state.mods[0]?.id ?? null);
  }, [state.mods, selectedModId]);
  const selectedMod = state.mods.find((mod) => mod.id === selectedModId) ?? null;

  const run = async (key: string, path: string, init?: RequestInit, onSubmitted?: () => void) => {
    setBusy(key);
    setError(null);
    try {
      const result = await modManagementAction(path, init);
      window.dispatchEvent(new Event(modsChangedEvent));
      onSubmitted?.();
      const next = await loadModManagement();
      setState({ ...next, restartRequired: next.restartRequired || result?.restartRequired === true });
      return true;
    } catch (cause) {
      setError(key === 'source' ? 'Could not add mod source. Check the URL and credentials.' : cause instanceof Error ? cause.message : 'Mod operation failed.');
      return false;
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
    const url = sourceUrl.trim();
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
      setSourceUrl('');
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
      <div><strong>{mod.name}{mod.system && <span className="mod-system-dot" role="img" aria-label="System mod" title="System mod" />}</strong><small>{mod.status === 'installed' ? (mod.enabled ? 'Installed · Enabled' : 'Installed · Disabled') : 'Available'}{mod.version ? ` · ${mod.version}` : ''}</small></div>
      <div className="memory-connection-actions"><button type="button" className="secondary memory-edit" aria-pressed={mod.id === selectedModId} disabled={busy !== null} onClick={() => setSelectedModId(mod.id)}>Manage</button></div>
    </article>)}</div>;
  const modInventory = overflowTarget
    ? <div className="settings-overflow-content memory-saved" aria-label="Mod catalog">{modInventoryContents}</div>
    : <details className="memory-saved saved-accordion" open><summary><h3>Mod catalog</h3><span>{state.mods.length}</span></summary>{modInventoryContents}</details>;

  const modConfiguration = <section className="setting-section mod-configuration" aria-labelledby="selected-mod-heading">
    <h2 id="selected-mod-heading">{selectedMod ? selectedMod.name : 'Mod details'}</h2>
    {selectedMod ? <>
      <p className="settings-description">Manage installation, version, and availability for this mod.</p>
      <Field label="Mod ID"><input value={selectedMod.id} readOnly /></Field>
      <div className="field-pair"><Field label="Current version"><input value={selectedMod.status === 'installed' ? selectedMod.version || 'Unknown' : 'Not installed'} readOnly /></Field><Field label="Latest version"><input value={selectedMod.latestVersion || 'Unknown'} readOnly /></Field></div>
      <p className="settings-description">{selectedMod.status === 'installed' ? `Installed · ${selectedMod.enabled ? 'Enabled' : 'Disabled'}` : 'Available from a configured source'}{selectedMod.reason ? ` · ${selectedMod.reason}` : ''}</p>
      <p className="settings-help">Install, update, and reinstall use the latest version-tagged release from the configured source. New installs start disabled; updates and reinstalls preserve the current enabled or disabled state.</p>
      <div className="model-actions">
        {selectedMod.status === 'installed' && <button className="danger" type="button" disabled={busy !== null} onClick={() => lifecycle(selectedMod, 'uninstall')}>{busy === selectedMod.id ? 'Working…' : 'Uninstall'}</button>}
        {selectedMod.status === 'installed' && <button className="secondary" type="button" disabled={busy !== null} onClick={() => lifecycle(selectedMod, selectedMod.enabled ? 'disable' : 'enable')}>{busy === selectedMod.id ? 'Working…' : selectedMod.enabled ? 'Disable' : 'Enable'}</button>}
        <button className={selectedMod.status === 'installed' ? 'secondary' : 'primary'} type="button" disabled={busy !== null || selectedMod.canInstall === false} onClick={() => install(selectedMod)}>{busy === selectedMod.id ? 'Working…' : actionLabel(selectedMod)}</button>
      </div>
    </> : <p className="settings-empty">Select a mod from the catalog to manage it.</p>}
  </section>;

  const sourceInventoryContents = state.sources.length === 0
    ? <p className="settings-empty">No custom sources configured.</p>
    : <div className="memory-connection-list">{state.sources.map((source: ModSource) => <article className="memory-connection" key={source.id}><div><strong>{source.url}</strong><small>{source.status || 'Unknown'}{source.lastCheckedAt ? ` · Checked ${formatCheckedTime(source.lastCheckedAt)}` : ''}{source.error ? ` · ${source.error}` : ''}</small></div><div className="memory-connection-actions"><button className="danger memory-edit" type="button" disabled={busy !== null} onClick={() => void run(source.id, `/api/mod-management/sources/${encodeURIComponent(source.id)}`, { method: 'DELETE' })}>Remove</button></div></article>)}</div>;
  const sourceInventory = overflowTarget
    ? <div className="settings-overflow-content memory-saved" aria-label="Configured mod sources">{sourceInventoryContents}</div>
    : <details className="memory-saved saved-accordion" open><summary><h3>Configured sources</h3><span>{state.sources.length}</span></summary>{sourceInventoryContents}</details>;
  const sourceConfiguration = <section className="setting-section mod-source-configuration" aria-labelledby="mod-sources-heading">
    <h2 id="mod-sources-heading">Mod sources</h2>
    <p className="settings-description">Add a Git repository URL (HTTP(S), ssh://, or scp-style SSH). Core discovers version-tagged releases containing burrow.mod.json.</p>
    <Field label="Git repository URL"><input value={sourceUrl} onChange={(event) => setSourceUrl(event.target.value)} placeholder="https://git.example.com/team/mod.git" /></Field>
    <Field label="Private repository username (optional)"><input value={sourceUsername} onChange={(event) => setSourceUsername(event.target.value)} autoComplete="off" /></Field>
    <Field label="Password or access token (optional)"><input ref={sourceSecretRef} type="password" autoComplete="new-password" /></Field>
    <p className="settings-help">Public repositories need only a URL. Credentials are for HTTPS Git repositories only and are stored encrypted by Core, not shown here again. For SSH, configure keys and host trust on the Core service account.</p>
    <div className="model-actions"><button className="secondary" type="button" disabled={busy !== null} onClick={() => void run('refresh', '/api/mod-management/refresh', { method: 'POST' })}>{busy === 'refresh' ? 'Refreshing…' : 'Refresh sources'}</button><button className="primary" type="button" disabled={!sourceUrl.trim() || busy !== null} onClick={() => void addSource()}>{busy === 'source' ? 'Adding…' : 'Add source'}</button></div>
  </section>;

  const primary = section === 'installed' ? modConfiguration : sourceConfiguration;
  const supporting = section === 'installed' ? modInventory : sourceInventory;
  return <div className="mod-management-settings">
    {error && <p className="settings-request-error" role="alert">{error}</p>}
    {state.restartRequired && <p className="settings-auth-warning mod-restart-notice" role="status"><strong>Restart required.</strong> Core needs a restart for the latest mod changes to take effect.</p>}
    {primary}
    {!overflowTarget && supporting}
    {overflowTarget && createPortal(supporting, overflowTarget)}
  </div>;
}
