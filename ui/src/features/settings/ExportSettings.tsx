import { useEffect, useState } from 'react';
import { api, downloadExport } from '../../app/api';
import { Field, SettingSection } from './SettingsPrimitives';

type ExportCategory = { id: string; label: string; description: string; containsSecrets: boolean };

export function ExportSettings() {
  const [categories, setCategories] = useState<ExportCategory[]>([]);
  const [selected, setSelected] = useState<string[]>(['settings']);
  const [password, setPassword] = useState('');
  const [state, setState] = useState<'idle' | 'loading' | 'exporting'>('loading');
  const [error, setError] = useState('');

  useEffect(() => {
    void api<{ categories: ExportCategory[]; passwordMinLength: number }>('/api/export/catalog')
      .then((result) => { setCategories(result.categories); setState('idle'); })
      .catch((reason) => {
        setError(reason instanceof Error ? reason.message : 'Could not load export options.');
        setState('idle');
      });
  }, []);

  const sensitive = categories.some((category) => selected.includes(category.id) && category.containsSecrets);
  const exportBundle = async () => {
    if (!selected.length || (sensitive && password.length < 12)) return;
    setState('exporting');
    setError('');
    try {
      const result = await downloadExport(selected, sensitive ? password : undefined);
      const url = URL.createObjectURL(result.blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = result.filename;
      link.click();
      URL.revokeObjectURL(url);
      setPassword('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not create export.');
    } finally {
      setState('idle');
    }
  };

  return <SettingSection title="Export">
    <p className="settings-help">Download selected Burrow configuration and work data as a portable bundle.</p>
    <div className="export-options">
      {categories.map((category) => <label className="export-option" key={category.id}>
        <input type="checkbox" checked={selected.includes(category.id)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, category.id] : current.filter((id) => id !== category.id))} />
        <span><b>{category.label}</b><small>{category.description}</small></span>
      </label>)}
    </div>
    {sensitive && <Field label="Export password (12+ characters)"><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" /></Field>}
    {error && <p className="settings-error" role="alert">{error}</p>}
    <div className="setting-actions">
      <button className="primary" type="button" onClick={() => void exportBundle()} disabled={state !== 'idle' || !selected.length || (sensitive && password.length < 12)}>
        {state === 'exporting' ? 'Creating export…' : 'Download export'}
      </button>
    </div>
  </SettingSection>;
}
