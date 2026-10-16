import { useEffect, useRef, useState } from 'react';
import { api, downloadExport, importExport } from '../../app/api';
import { useConfirm } from '../../app/ConfirmDialog';
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
  const confirm = useConfirm();
  const applying = useRef(false);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [categories, setCategories] = useState<ExportCategory[]>([]);
  const [selected, setSelected] = useState<string[]>(['settings']);
  const [password, setPassword] = useState('');
  const [state, setState] = useState<'idle' | 'loading' | 'exporting'>('loading');
  const [error, setError] = useState('');
  const [importPayload, setImportPayload] = useState('');
  const [importName, setImportName] = useState('');
  const [importPassword, setImportPassword] = useState('');
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null);
  const [previewedInputs, setPreviewedInputs] = useState<string | null>(null);
  const [passwordNeeded, setPasswordNeeded] = useState(false);
  const previewSequence = useRef(0);
  const [importState, setImportState] = useState<'idle' | 'previewing' | 'confirming' | 'importing'>('idle');
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

  const previewImport = async (payload: string, passwordValue = '') => {
    const sequence = ++previewSequence.current;
    const inputs = JSON.stringify([payload, passwordValue, conflictPolicy]);
    setPreviewedInputs(null); setImportPreview(null); setError(''); setImportState('previewing');
    try {
      const preview = await importExport({ payload, ...(passwordValue ? { password: passwordValue } : {}), conflictPolicy }, true) as ImportPreview;
      if (sequence === previewSequence.current) { setImportPreview(preview); setPreviewedInputs(inputs); }
    } catch (reason) {
      if (sequence !== previewSequence.current) return;
      if (reason instanceof Error && reason.message === 'import_password_required') {
        setPasswordNeeded(true); setImportPreview({ encrypted: true, requiresPassword: true });
        setError('This export is encrypted. Enter its password, then preview it again.');
      } else setError(importErrorMessage(reason));
    } finally { if (sequence === previewSequence.current) setImportState('idle'); }
  };

  const readImportFile = async (file?: File) => {
    if (!file) return;
    const sequence = ++previewSequence.current;
    setError(''); setImportState('previewing'); setImportPreview(null); setPreviewedInputs(null); setPasswordNeeded(false); setImportPassword(''); setImportPayload(''); setImportName(file.name);
    try {
      const payload = await fileToBase64(file);
      if (sequence !== previewSequence.current) return;
      setImportPayload(payload);
      await previewImport(payload);
    } catch (reason) { if (sequence === previewSequence.current) { setError(importErrorMessage(reason)); setImportPayload(''); setImportName(''); } }
    finally { if (sequence === previewSequence.current) setImportState('idle'); }
  };

  const previewIsCurrent = Boolean(importPreview && previewedInputs === JSON.stringify([importPayload, importPassword, conflictPolicy]));
  const applyImport = async () => {
    if (importState !== 'idle' || !previewIsCurrent || !importPayload || (importPreview?.requiresPassword && !importPassword.trim())) return;
    if (applying.current) return;
    applying.current = true; setImportState('confirming');
    try {
      if (!await confirm({ title: 'Import this export?', message: 'Existing matching data may be changed according to the selected conflict policy. This cannot be undone from the UI.', confirmLabel: 'Import export', tone: 'danger' }) || !mounted.current) return;
      setError(''); setImportState('importing');
      await importExport({ payload: importPayload, ...(importPassword ? { password: importPassword } : {}), confirm: true, conflictPolicy });
      setImportPayload(''); setImportName(''); setImportPassword(''); setImportPreview(null); setPreviewedInputs(null); setPasswordNeeded(false);
      if (importInput.current) importInput.current.value = '';
    } catch (reason) { setError(importErrorMessage(reason)); }
    finally { applying.current = false; if (mounted.current) setImportState('idle'); }
  };

  return <>
    <SettingSection title="Export">
      <p className="settings-help">Download selected Burrow configuration and work data as a portable bundle, not a full backup. Chats, workspace files, historical runs and mod-owned state are not included.</p>
      <div className="export-options">
        {categories.map((category) => <label className="export-option" key={category.id}>
          <input type="checkbox" checked={selected.includes(category.id)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, category.id] : current.filter((id) => id !== category.id))} />
          <span><b>{category.label}</b><small>{category.description}</small></span>
        </label>)}
      </div>
      <p className="settings-help">Dependencies are not selected automatically. Include agents for skill assignments, model connections for agent model selections or embeddings, and agents, model connections and settings (operator timezone) for scheduled jobs, unless already configured on the destination.</p>
      {selected.includes('settings') && <p className="settings-help">Settings includes operator timezone, retention policies and embedding configuration, not memories or vectors.</p>}
      <p className="settings-help">Review free-text profiles, skills and job prompts for credentials before sharing; non-secret field redaction does not detect secrets in prose.</p>
      {sensitive && <Field label="Export password (12+ characters)"><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" /></Field>}
      <div className="setting-actions"><button className="primary" type="button" onClick={() => void exportBundle()} disabled={state !== 'idle' || !selected.length || (sensitive && password.length < 12)}>{state === 'exporting' ? 'Creating export…' : 'Download export'}</button></div>
    </SettingSection>
    <SettingSection title="Import">
      <p className="settings-help">Restore data from a Burrow export. Review the preview before applying changes. Bundled, Git-managed and filesystem skill packages are not installed. Reconfigure destination-local paths, services and environment secrets separately.</p>
      <input ref={importInput} className="export-file-input" disabled={importState !== 'idle'} type="file" accept=".json.gz,.gz,.hc-export,.tar,.bin,application/octet-stream,application/gzip" onChange={(event) => { void readImportFile(event.target.files?.[0]); }} />
      <button className="secondary" type="button" onClick={() => importInput.current?.click()} disabled={importState !== 'idle'}>{importState === 'previewing' ? 'Reading export…' : 'Choose export file'}</button>
      {importName && <p className="import-file-name" role="status">Selected: <strong>{importName}</strong></p>}
      {importName && <Field label="Conflict handling"><select disabled={importState !== 'idle'} value={conflictPolicy} onChange={(event) => { setConflictPolicy(event.target.value as typeof conflictPolicy); setImportPreview(null); setPreviewedInputs(null); }}><option value="error">Stop if conflicts exist</option><option value="skip">Skip conflicting items</option><option value="replace">Replace conflicting items</option></select></Field>}
      {passwordNeeded && <Field label="Export password"><input type="password" disabled={importState !== 'idle'} value={importPassword} onChange={(event) => { setImportPassword(event.target.value); setImportPreview(null); setPreviewedInputs(null); }} autoComplete="off" /></Field>}
      {importName && importPayload && importState === 'idle' && !previewIsCurrent && <button className="secondary" type="button" onClick={() => void previewImport(importPayload, importPassword)}>Preview export</button>}
      {previewIsCurrent && importPreview && <div className="import-preview" aria-live="polite"><strong>Export preview</strong><span>Supported: {importSummary(importPreview.supported ?? importPreview.categories)}</span>{importPreview.unsupported !== undefined && <span>Unsupported: {importSummary(importPreview.unsupported)}</span>}<p className="import-warning">Importing changes Burrow data. Enabled scheduled jobs remain enabled and may run after import. Imports can apply partially if a dependency fails; inspect the error before explicitly retrying. This cannot be undone from the UI.</p><button className="primary" type="button" onClick={() => void applyImport()} disabled={importState !== 'idle' || !previewIsCurrent || Boolean(importPreview.requiresPassword || importPreview.encrypted) && !importPassword.trim()}>{importState === 'importing' ? 'Importing…' : 'Import export'}</button></div>}
      {error && <p className="settings-error" role="alert">{error}</p>}
    </SettingSection>
  </>;
}
