import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
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
  return mod.updateAvailable ? 'Update' : 'Up to date';
}

export function ModsSettings({ section = 'installed', overflowTarget }: Props) {
  const [state, setState] = useState<NormalizedModManagement>({ mods: [], sources: [], restartRequired: false });
  const [selectedModId, setSelectedModId] = useState<string | null>(null);
  const [sourceUrl, setSourceUrl] = useState('');
  const [version, setVersion] = useState('');
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

  const run = async (key: string, path: string, init?: RequestInit) => {
    setBusy(key);
    setError(null);
    try {
      const result = await modManagementAction(path, init);
      const next = await loadModManagement();
      setState({ ...next, restartRequired: next.restartRequired || result?.restartRequired === true });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Mod operation failed.');
    } finally {
      setBusy(null);
    }
  };

  const install = (mod: ModRecord) => {
    const selectedVersion = version.trim();
    setVersion('');
    void run(mod.id, modLifecyclePath(mod.id, 'install'), { method: 'POST', body: JSON.stringify(selectedVersion ? { version: selectedVersion } : {}) });
  };
  const lifecycle = (mod: ModRecord, action: 'uninstall' | 'enable' | 'disable') => {
    void run(mod.id, modLifecyclePath(mod.id, action), { method: 'POST' });
  };
  const addSource = () => {
    const url = sourceUrl.trim();
    if (!url) return;
    void run('source', '/api/mod-management/sources', { method: 'POST', body: JSON.stringify({ url }) }).then(() => setSourceUrl(''));
  };

  const modInventoryContents = state.mods.length === 0
    ? <p className="settings-empty">No mods found. Add a source in Mod sources.</p>
    : <div className="memory-connection-list">{state.mods.map((mod) => <article className="memory-connection" key={mod.id}>
      <div><strong>{mod.name}{mod.system && <span className="mod-system-dot" role="img" aria-label="System mod" title="System mod" />}</strong><small>{mod.status === 'installed' ? (mod.enabled ? 'Installed · Enabled' : 'Installed · Disabled') : 'Available'}{mod.version ? ` · ${mod.version}` : ''}</small></div>
      <div className="memory-connection-actions"><button type="button" className="secondary memory-edit" aria-pressed={mod.id === selectedModId} disabled={busy !== null} onClick={() => { setSelectedModId(mod.id); setVersion(''); }}>Manage</button></div>
    </article>)}</div>;
  const modInventory = overflowTarget
    ? <div className="settings-overflow-content memory-saved" aria-label="Mod catalog">{modInventoryContents}</div>
    : <details className="memory-saved saved-accordion" open><summary><h3>Mod catalog</h3><span>{state.mods.length}</span></summary>{modInventoryContents}</details>;

  const modConfiguration = <section className="setting-section mod-configuration" aria-labelledby="selected-mod-heading">
    <h2 id="selected-mod-heading">{selectedMod ? selectedMod.name : 'Mod details'}</h2>
    {selectedMod ? <>
      <p className="settings-description">Manage installation, version, and availability for this mod.</p>
      <Field label="Mod ID"><input value={selectedMod.id} readOnly /></Field>
      <div className="field-pair"><Field label="Current version"><input value={selectedMod.version || 'Not installed'} readOnly /></Field><Field label="Install version"><input value={version} onChange={(event) => setVersion(event.target.value)} placeholder={selectedMod.latestVersion || 'Latest available'} /></Field></div>
      <p className="settings-description">{selectedMod.status === 'installed' ? `Installed · ${selectedMod.enabled ? 'Enabled' : 'Disabled'}` : 'Available from a configured source'}{selectedMod.latestVersion ? ` · Latest ${selectedMod.latestVersion}` : ''}{selectedMod.reason ? ` · ${selectedMod.reason}` : ''}</p>
      <div className="model-actions">
        {selectedMod.status === 'installed' && <button className="danger" type="button" disabled={busy !== null} onClick={() => lifecycle(selectedMod, 'uninstall')}>{busy === selectedMod.id ? 'Working…' : 'Uninstall'}</button>}
        {selectedMod.status === 'installed' && <button className="secondary" type="button" disabled={busy !== null} onClick={() => lifecycle(selectedMod, selectedMod.enabled ? 'disable' : 'enable')}>{busy === selectedMod.id ? 'Working…' : selectedMod.enabled ? 'Disable' : 'Enable'}</button>}
        <button className={selectedMod.status === 'installed' ? 'secondary' : 'primary'} type="button" disabled={busy !== null || (selectedMod.status === 'installed' ? !selectedMod.updateAvailable : selectedMod.canInstall === false)} onClick={() => install(selectedMod)}>{busy === selectedMod.id ? 'Working…' : actionLabel(selectedMod)}</button>
      </div>
    </> : <p className="settings-empty">Select a mod from the catalog to manage it.</p>}
  </section>;

  const sourceInventoryContents = state.sources.length === 0
    ? <p className="settings-empty">No custom sources configured.</p>
    : <div className="memory-connection-list">{state.sources.map((source: ModSource) => <article className="memory-connection" key={source.id}><div><strong>{source.url}</strong><small>{source.status || 'Unknown'}{source.lastCheckedAt ? ` · Checked ${formatCheckedTime(source.lastCheckedAt)}` : ''}{source.error ? ` · ${source.error}` : ''}</small></div><div className="memory-connection-actions"><button className="danger memory-edit" type="button" disabled={busy !== null} onClick={() => void run(source.id, `/api/mod-management/sources/${encodeURIComponent(source.id)}`, { method: 'DELETE' })}>Remove</button></div></article>)}</div>;
  const sourceInventory = overflowTarget
    ? <div className="settings-overflow-content memory-saved" aria-label="Configured mod sources">{sourceInventoryContents}</div>
    : <details className="memory-saved saved-accordion" open><summary><h3>Configured sources</h3><span>{state.sources.length}</span></summary>{sourceInventoryContents}</details>;
  const sourceConfiguration = <section className="setting-section mod-source-configuration" aria-labelledby="mod-sources-heading"><h2 id="mod-sources-heading">Mod sources</h2><p className="settings-description">Add a source URL for Core to check for mod releases.</p><Field label="Source URL"><input value={sourceUrl} onChange={(event) => setSourceUrl(event.target.value)} placeholder="https://example.invalid/mods.json" /></Field><div className="model-actions"><button className="secondary" type="button" disabled={busy !== null} onClick={() => void run('refresh', '/api/mod-management/refresh', { method: 'POST' })}>{busy === 'refresh' ? 'Refreshing…' : 'Refresh sources'}</button><button className="primary" type="button" disabled={!sourceUrl.trim() || busy !== null} onClick={addSource}>{busy === 'source' ? 'Adding…' : 'Add source'}</button></div></section>;

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
