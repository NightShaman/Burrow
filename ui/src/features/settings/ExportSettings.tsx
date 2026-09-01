import { useEffect, useRef, useState } from 'react';
import { api, downloadExport, importExport } from '../../app/api';
import { Field, SettingSection } from './SettingsPrimitives';

type ExportCategory = { id: string; label: string; description: string; containsSecrets: boolean };
type ImportPreview = { encrypted?: boolean; requiresPassword?: boolean; categories?: Record<string, unknown> | string[]; supported?: unknown; unsupported?: unknown; requiresConfirmation?: boolean; conflicts?: unknown[] };

const importErrorMessage = (cause: unknown) => cause instanceof Error && cause.message === 'import_password_required'
  ? 'This export is encrypted. Enter its password to continue.'
  : cause instanceof Error ? `Could not import export: ${cause.message}` : 'Could not import export.';

async function fileToBase64(file: File) {
  let binary = '';
  new Uint8Array(await file.arrayBuffer()).forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary);
}

function importSummary(value: unknown) {
  if (Array.isArray(value)) return value.length ? `${value.length} item${value.length === 1 ? '' : 's'}` : 'None';
  if (value && typeof value === 'object') return `${Object.keys(value).length} categor${Object.keys(value).length === 1 ? 'y' : 'ies'}`;
  return 'None';
}

export function ExportSettings() {
  const [categories, setCategories] = useState<ExportCategory[]>([]);
  const [selected, setSelected] = useState<string[]>(['settings']);
  const [password, setPassword] = useState('');
  const [state, setState] = useState<'idle' | 'loading' | 'exporting'>('loading');
  const [error, setError] = useState('');
  const [importPayload, setImportPayload] = useState('');
  const [importName, setImportName] = useState('');
  const [importPassword, setImportPassword] = useState('');
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null);
  const [importState, setImportState] = useState<'idle' | 'previewing' | 'importing'>('idle');
  const [conflictPolicy, setConflictPolicy] = useState<'error' | 'skip' | 'replace'>('error');
  const importInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void api<{ categories: ExportCategory[]; passwordMinLength: number }>('/api/export/catalog')
      .then((result) => { setCategories(result.categories); setState('idle'); })
      .catch((reason) => { setError(reason instanceof Error ? reason.message : 'Could not load export options.'); setState('idle'); });
  }, []);

  const sensitive = categories.some((category) => selected.includes(category.id) && category.containsSecrets);
  const exportBundle = async () => {
    if (!selected.length || (sensitive && password.length < 12)) return;
    setState('exporting'); setError('');
    try {
      const result = await downloadExport(selected, sensitive ? password : undefined);
      const url = URL.createObjectURL(result.blob); const link = document.createElement('a');
      link.href = url; link.download = result.filename; link.click(); URL.revokeObjectURL(url); setPassword('');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not create export.'); }
    finally { setState('idle'); }
  };

  const readImportFile = async (file?: File) => {
    if (!file) return;
    setError(''); setImportState('previewing'); setImportPreview(null); setImportPassword('');
    try {
      const payload = await fileToBase64(file);
      const preview = await importExport({ payload, conflictPolicy }, true) as ImportPreview;
      setImportPayload(payload); setImportName(file.name); setImportPreview(preview);
    } catch (reason) { setError(importErrorMessage(reason)); setImportPayload(''); setImportName(''); }
    finally { setImportState('idle'); }
  };

  const applyImport = async () => {
    if (!importPayload || (importPreview?.requiresPassword && !importPassword.trim())) return;
    if (!window.confirm('Import this export? Existing matching data may be changed according to the selected conflict policy.')) return;
    setError(''); setImportState('importing');
    try {
      await importExport({ payload: importPayload, ...(importPassword ? { password: importPassword } : {}), confirm: true, conflictPolicy });
      setImportPayload(''); setImportName(''); setImportPassword(''); setImportPreview(null);
      if (importInput.current) importInput.current.value = '';
    } catch (reason) { setError(importErrorMessage(reason)); }
    finally { setImportState('idle'); }
  };

  return <>
    <SettingSection title="Export">
      <p className="settings-help">Download selected Burrow configuration and work data as a portable bundle.</p>
      <div className="export-options">
        {categories.map((category) => <label className="export-option" key={category.id}>
          <input type="checkbox" checked={selected.includes(category.id)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, category.id] : current.filter((id) => id !== category.id))} />
          <span><b>{category.label}</b><small>{category.description}</small></span>
        </label>)}
      </div>
      {sensitive && <Field label="Export password (12+ characters)"><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" /></Field>}
      <div className="setting-actions"><button className="primary" type="button" onClick={() => void exportBundle()} disabled={state !== 'idle' || !selected.length || (sensitive && password.length < 12)}>{state === 'exporting' ? 'Creating export…' : 'Download export'}</button></div>
    </SettingSection>
    <SettingSection title="Import">
      <p className="settings-help">Restore data from a Burrow export. Review the preview before applying changes.</p>
      <input ref={importInput} className="export-file-input" type="file" accept=".json.gz,.gz,.hc-export,.tar,.bin,application/octet-stream,application/gzip" onChange={(event) => { void readImportFile(event.target.files?.[0]); }} />
      <button className="secondary" type="button" onClick={() => importInput.current?.click()} disabled={importState !== 'idle'}>{importState === 'previewing' ? 'Reading export…' : 'Choose export file'}</button>
      {importName && <p className="import-file-name" role="status">Selected: <strong>{importName}</strong></p>}
      {importPreview && <div className="import-preview" aria-live="polite"><strong>Export preview</strong><span>Supported: {importSummary(importPreview.supported ?? importPreview.categories)}</span>{importPreview.unsupported !== undefined && <span>Unsupported: {importSummary(importPreview.unsupported)}</span>}<Field label="Conflict handling"><select value={conflictPolicy} onChange={(event) => setConflictPolicy(event.target.value as typeof conflictPolicy)}><option value="error">Stop if conflicts exist</option><option value="skip">Skip conflicting items</option><option value="replace">Replace conflicting items</option></select></Field>{(importPreview.requiresPassword || importPreview.encrypted) && <Field label="Export password"><input type="password" value={importPassword} onChange={(event) => setImportPassword(event.target.value)} autoComplete="off" /></Field>}<p className="import-warning">Importing changes Burrow data. This cannot be undone from the UI.</p><button className="primary" type="button" onClick={() => void applyImport()} disabled={importState !== 'idle' || Boolean(importPreview.requiresPassword || importPreview.encrypted) && !importPassword.trim()}>{importState === 'importing' ? 'Importing…' : 'Import export'}</button></div>}
      {error && <p className="settings-error" role="alert">{error}</p>}
    </SettingSection>
  </>;
}
