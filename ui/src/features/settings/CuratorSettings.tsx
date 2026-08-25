import { useEffect, useState } from 'react';
import { api } from '../../app/api';
import type { SavedProvider } from '../../app/types';
import { Field, SettingSection } from './SettingsPrimitives';

type CuratorSelection =
  | { kind: 'external'; connectionId: string; model: string; temperature?: number }
  | { kind: 'local'; modelPath: string; contextSize?: number; gpuLayers?: number; temperature?: number };
type CuratorStatus = {
  ok: boolean;
  configured: boolean;
  selection?: CuratorSelection | null;
  root?: string;
  available?: boolean;
  implementation?: string;
  modelPath?: string;
  reason?: string;
};

type CuratorMode = CuratorSelection['kind'];

export function CuratorSettings({ savedProviders }: { savedProviders: SavedProvider[] }) {
  const externalOptions = savedProviders.flatMap((provider) => provider.models.map((model) => ({ provider, model, value: JSON.stringify({ connectionId: provider.id, model }) })));
  const [mode, setMode] = useState<CuratorMode>('external');
  const [externalValue, setExternalValue] = useState(externalOptions[0]?.value ?? '');
  const [localPath, setLocalPath] = useState('');
  const [contextSize, setContextSize] = useState('4096');
  const [gpuLayers, setGpuLayers] = useState('0');
  const [temperature, setTemperature] = useState('0');
  const [status, setStatus] = useState<CuratorStatus | null>(null);
  const [requestState, setRequestState] = useState<'loading' | 'idle' | 'saving'>('loading');
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setRequestState('loading'); setError('');
      try {
        const result = await api<CuratorStatus>('/api/settings/curator');
        if (cancelled) return;
        setStatus(result);
        if (result.selection?.kind === 'external') {
          setMode('external');
          setExternalValue(JSON.stringify({ connectionId: result.selection.connectionId, model: result.selection.model }));
          setTemperature(String(result.selection.temperature ?? 0));
        } else if (result.selection?.kind === 'local') {
          setMode('local');
          setLocalPath(result.selection.modelPath ?? '');
          setContextSize(String(result.selection.contextSize ?? 4096));
          setGpuLayers(String(result.selection.gpuLayers ?? 0));
          setTemperature(String(result.selection.temperature ?? 0));
        }
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? `Could not load curator settings: ${cause.message}` : 'Could not load curator settings.');
      } finally { if (!cancelled) setRequestState('idle'); }
    };
    load();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!externalValue && externalOptions[0]?.value) setExternalValue(externalOptions[0].value);
  }, [externalOptions, externalValue]);

  const save = async () => {
    setRequestState('saving'); setError('');
    try {
      const nextTemperature = Math.min(0.5, Math.max(0, Number(temperature) || 0));
      let body: CuratorSelection;
      if (mode === 'external') {
        if (!externalValue) throw new Error('Choose an enabled model connection model.');
        const parsed = JSON.parse(externalValue) as { connectionId: string; model: string };
        body = { kind: 'external', connectionId: parsed.connectionId, model: parsed.model, temperature: nextTemperature };
      } else {
        const nextPath = localPath.trim();
        if (!nextPath) throw new Error('Enter a curator GGUF path below the curator root.');
        body = { kind: 'local', modelPath: nextPath, contextSize: Number(contextSize) || 4096, gpuLayers: Number(gpuLayers) || 0, temperature: nextTemperature };
      }
      const result = await api<CuratorStatus>('/api/settings/curator', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      setStatus(result);
      setTemperature(String(result.selection?.temperature ?? nextTemperature));
    } catch (cause) {
      setError(cause instanceof Error ? `Could not save curator settings: ${cause.message}` : 'Could not save curator settings.');
    } finally { setRequestState('idle'); }
  };

  const selectedExternalExists = externalOptions.some((option) => option.value === externalValue);
  const disabled = requestState === 'loading' || requestState === 'saving';

  return <SettingSection title="Tiddle Signal"><div className="curator-card"><p className="hint">Maintains warm conversational continuity by periodically reviewing recent session activity for recurring people, projects, threads, decisions, and other meaningful context. Uses rolling continuity cards with roughly a 30-day horizon. It does not control active task state or automatically steer the current conversation.</p><div className="curator-mode" role="radiogroup" aria-label="Tiddle Signal model source"><label><input type="radio" name="curator-mode" checked={mode === 'external'} onChange={() => setMode('external')} /> Existing model connection</label><label><input type="radio" name="curator-mode" checked={mode === 'local'} onChange={() => setMode('local')} /> Local GGUF</label></div>{mode === 'external' ? <div className="curator-model-row"><Field label="Model"><select value={externalValue} onChange={(event) => setExternalValue(event.target.value)} disabled={disabled || externalOptions.length === 0}>{!selectedExternalExists && externalValue && <option value={externalValue}>Configured model</option>}{externalOptions.map(({ provider, model, value }) => <option value={value} key={value}>{provider.provider} · {model}</option>)}</select></Field><Field label={`Temperature · ${Number(temperature).toFixed(2)}`}><input type="range" min="0" max="0.5" step="0.01" value={temperature} onChange={(event) => setTemperature(event.target.value)} disabled={disabled} aria-describedby="tiddle-temperature-help" /></Field></div> : <><Field label="Model path"><input value={localPath} onChange={(event) => setLocalPath(event.target.value)} placeholder="models/LFM2.5-2.6B-Q4_K_M.gguf" disabled={disabled} /></Field><div className="field-pair compact-fields"><Field label="Context size"><input type="number" min="1" step="1" value={contextSize} onChange={(event) => setContextSize(event.target.value)} disabled={disabled} /></Field><Field label="GPU layers"><input type="number" min="0" step="1" value={gpuLayers} onChange={(event) => setGpuLayers(event.target.value)} disabled={disabled} /></Field></div><Field label={`Temperature · ${Number(temperature).toFixed(2)}`}><input type="range" min="0" max="0.5" step="0.01" value={temperature} onChange={(event) => setTemperature(event.target.value)} disabled={disabled} aria-describedby="tiddle-temperature-help" /></Field></>}<p className="hint" id="tiddle-temperature-help">Controls how much variation Tiddle Signal uses when creating continuity cards. Lower values are more consistent; higher values are warmer and more varied.</p>{status && <p className={`curator-status ${status.available ? 'available' : 'unavailable'}`}>{status.available ? 'Available' : 'Unavailable'}{status.reason ? ` · ${status.reason}` : ''}{status.root ? ` · root: ${status.root}` : ''}</p>}{mode === 'external' && externalOptions.length === 0 && <p className="settings-request-error" role="alert">Add a model connection before selecting an external curator model.</p>}{error && <p className="settings-request-error" role="alert">{error}</p>}<button type="button" className="primary" onClick={save} disabled={disabled}>{requestState === 'saving' ? 'Saving…' : 'Save Tiddle Settings'}</button></div></SettingSection>;
}
