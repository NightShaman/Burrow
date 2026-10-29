import { isUnsavedChangesModalTarget, useUnsavedChanges } from '../../app/UnsavedChanges';
import { ProviderModelFields } from './ProviderModelFields';
import { useEffect, useRef, useState } from 'react';
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

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const isNonemptyString = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
function isCuratorSelection(value: unknown): value is CuratorSelection {
  if (!isRecord(value)) return false;
  if (value.temperature !== undefined && (!isFiniteNumber(value.temperature) || value.temperature < 0 || value.temperature > 0.5)) return false;
  if (value.kind === 'external') return isNonemptyString(value.connectionId) && isNonemptyString(value.model);
  if (value.kind === 'local') return isNonemptyString(value.modelPath)
    && (value.contextSize === undefined || (isFiniteNumber(value.contextSize) && value.contextSize > 0))
    && (value.gpuLayers === undefined || isFiniteNumber(value.gpuLayers));
  return false;
}
function validateCuratorStatus(value: unknown, requireSelection = false): asserts value is CuratorStatus {
  // Both endpoints return runtime status. A successful PUT must confirm the saved
  // selection; an ok-only acknowledgement is not authority to accept our draft.
  if (!isRecord(value) || value.ok !== true || typeof value.configured !== 'boolean'
    || (requireSelection && !value.configured)
    || (value.configured ? !isCuratorSelection(value.selection) : value.selection != null)) {
    throw new Error('Invalid curator settings response.');
  }
}

type CuratorMode = CuratorSelection['kind'];
const adjustmentKeys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'];
const normalizedTemperature = (value: string) => Math.min(0.5, Math.max(0, Number(value) || 0));

export function CuratorSettings({ savedProviders }: { savedProviders: SavedProvider[] }) {
  const externalOptions = savedProviders.flatMap((provider) => provider.models.map((model) => ({ provider, model, value: JSON.stringify({ connectionId: provider.id, model }) })));
  const [mode, setMode] = useState<CuratorMode>('external');
  const [externalValue, setExternalValue] = useState(externalOptions[0]?.value ?? '');
  const [localPath, setLocalPath] = useState('');
  const [contextSize, setContextSize] = useState('4096');
  const [gpuLayers, setGpuLayers] = useState('0');
  const [temperature, setTemperature] = useState('0');
  const [status, setStatus] = useState<CuratorStatus | null>(null);
  const [requestState, setRequestState] = useState<'loading' | 'idle' | 'saving' | 'error'>('loading');
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [baseline, setBaseline] = useState('');
  const owner = useRef<object | null>(null);
  const saving = useRef(false);
  const acceptedSelection = useRef<CuratorSelection | null>(null);
  const temperatureDraft = useRef('0');
  const temperatureInteraction = useRef(false);
  const [notice, setNotice] = useState('');
  const [temperatureFailed, setTemperatureFailed] = useState(false);

  const snapshot = JSON.stringify({ mode, externalValue, localPath, contextSize, gpuLayers, temperature });
  const restore = (key: string) => { const draft = JSON.parse(key) as { mode: CuratorMode; externalValue: string; localPath: string; contextSize: string; gpuLayers: string; temperature: string }; setMode(draft.mode); setExternalValue(draft.externalValue); setLocalPath(draft.localPath); setContextSize(draft.contextSize); setGpuLayers(draft.gpuLayers); temperatureDraft.current = draft.temperature; setTemperature(draft.temperature); };
  useEffect(() => {
    const ticket = {}; owner.current = ticket;
    const controller = new AbortController();
    const load = async () => {
      saving.current = false; acceptedSelection.current = null; temperatureInteraction.current = false;
      setRequestState('loading'); setStatus(null); setError(''); setNotice(''); setTemperatureFailed(false);
      try {
        const result = await api<CuratorStatus>('/api/settings/curator', { signal: controller.signal });
        if (owner.current !== ticket) return;
        validateCuratorStatus(result);
        acceptedSelection.current = result.configured ? result.selection ?? null : null;
        temperatureDraft.current = String(result.selection?.temperature ?? 0);
        setStatus(result); setRequestState('idle');
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
        // Capture the accepted server selection, including inactive-mode defaults.
        setBaseline(JSON.stringify({ mode: result.selection?.kind ?? 'external', externalValue: result.selection?.kind === 'external' ? JSON.stringify({ connectionId: result.selection.connectionId, model: result.selection.model }) : externalValue, localPath: result.selection?.kind === 'local' ? result.selection.modelPath ?? '' : localPath, contextSize: result.selection?.kind === 'local' ? String(result.selection.contextSize ?? 4096) : contextSize, gpuLayers: result.selection?.kind === 'local' ? String(result.selection.gpuLayers ?? 0) : gpuLayers, temperature: String(result.selection?.temperature ?? 0) }));
      } catch (cause) {
        if (owner.current === ticket) { setError(cause instanceof Error ? `Could not load curator settings: ${cause.message}` : 'Could not load curator settings.'); setRequestState('error'); }
      }
    };
    load();
    return () => { owner.current = null; controller.abort(); };
  }, [retry]);

  const save = async () => {
    if (requestState !== 'idle' || !status || !owner.current || saving.current) return false;
    const ticket = owner.current;
    if (snapshot === baseline && status.configured) return true;
    saving.current = true;
    setRequestState('saving'); setError(''); setNotice('');
    try {
      const nextTemperature = normalizedTemperature(temperature);
      let body: CuratorSelection;
      if (mode === 'external') {
        if (!externalValue) throw new Error('Choose an enabled model connection model.');
        const parsed = JSON.parse(externalValue) as { connectionId: string; model: string };
        if (!parsed.connectionId || !parsed.model) throw new Error('Choose a model for the selected provider.');
        body = { kind: 'external', connectionId: parsed.connectionId, model: parsed.model, temperature: nextTemperature };
      } else {
        const nextPath = localPath.trim();
        if (!nextPath) throw new Error('Enter a curator GGUF path below the curator root.');
        body = { kind: 'local', modelPath: nextPath, contextSize: Number(contextSize) || 4096, gpuLayers: Number(gpuLayers) || 0, temperature: nextTemperature };
      }
      const result = await api<CuratorStatus>('/api/settings/curator', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (owner.current !== ticket) return false;
      validateCuratorStatus(result, true);
      acceptedSelection.current = result.selection!;
      setStatus(result); setTemperatureFailed(false); setNotice('Tiddle settings saved.');
      const accepted = JSON.stringify({ mode, externalValue, localPath, contextSize, gpuLayers, temperature: String(result.selection?.temperature ?? nextTemperature) });
      setBaseline(accepted); restore(accepted);
      return true;
    } catch (cause) {
      if (owner.current === ticket) setError(cause instanceof Error ? `Could not save curator settings: ${cause.message}` : 'Could not save curator settings.');
      return false;
    } finally { if (owner.current === ticket) { saving.current = false; setRequestState('idle'); } }
  };

  // Temperature is independent only when there is an accepted model identity.
  // The PUT endpoint replaces a whole selection: never build this autosave from
  // mode/provider/path/context/GPU drafts, even when they happen to be valid.
  const saveTemperature = async () => {
    const selection = acceptedSelection.current;
    if (requestState !== 'idle' || !owner.current || saving.current || !selection) return false;
    const nextTemperature = normalizedTemperature(temperatureDraft.current);
    if (nextTemperature === (selection.temperature ?? 0)) {
      setTemperatureFailed(false); setError(''); setNotice('');
      return true;
    }
    const ticket = owner.current;
    saving.current = true;
    setRequestState('saving'); setError(''); setNotice('');
    try {
      const result = await api<CuratorStatus>('/api/settings/curator', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...selection, temperature: nextTemperature }) });
      if (owner.current !== ticket) return false;
      validateCuratorStatus(result, true);
      const accepted = result.selection!;
      acceptedSelection.current = accepted;
      setStatus(result);
      const value = String(accepted.temperature ?? nextTemperature);
      temperatureDraft.current = value; setTemperature(value);
      // Advance only this field's baseline; unrelated model edits remain dirty.
      setBaseline(current => JSON.stringify({ ...JSON.parse(current), temperature: value }));
      setTemperatureFailed(false); setNotice('Tiddle temperature saved.');
      return true;
    } catch (cause) {
      if (owner.current === ticket) {
        setError(cause instanceof Error ? `Could not save Tiddle temperature: ${cause.message}` : 'Could not save Tiddle temperature.');
        setTemperatureFailed(true);
      }
      return false;
    } finally {
      if (owner.current === ticket) { saving.current = false; setRequestState('idle'); }
    }
  };
  const commitTemperature = () => {
    if (!temperatureInteraction.current) return;
    temperatureInteraction.current = false;
    void saveTemperature();
  };
  const temperatureControl = <Field label={`Temperature · ${Number(temperature).toFixed(2)}`}><input type="range" min="0" max="0.5" step="0.01" value={temperature}
    onPointerDown={event => { temperatureInteraction.current = true; event.currentTarget.setPointerCapture?.(event.pointerId); }}
    onPointerUp={commitTemperature} onPointerCancel={commitTemperature} onLostPointerCapture={commitTemperature}
    onKeyDown={event => { if (adjustmentKeys.includes(event.key)) temperatureInteraction.current = true; }}
    onKeyUp={event => { if (adjustmentKeys.includes(event.key)) commitTemperature(); }}
    onBlur={event => { if (isUnsavedChangesModalTarget(event.relatedTarget)) { temperatureInteraction.current = false; return; } commitTemperature(); }}
    onChange={event => { temperatureDraft.current = event.target.value; setTemperature(event.target.value); temperatureInteraction.current = true; setNotice(''); }}
    disabled={requestState !== 'idle' || !status} aria-describedby="tiddle-temperature-help" /></Field>;

  useUnsavedChanges({ dirty: requestState !== 'loading' && requestState !== 'error' && !!baseline && snapshot !== baseline, busy: requestState === 'saving', resumeAfterAutosave: true, save, discard: () => { if (baseline) restore(baseline); temperatureInteraction.current = false; setTemperatureFailed(false); setError(''); setNotice(''); } });
  const disabled = requestState !== 'idle' || !status;

  return <SettingSection title="Tiddle Signal"><div className="curator-card"><p className="hint">Maintains warm conversational continuity by periodically reviewing recent session activity for recurring people, projects, threads, decisions, and other meaningful context. Uses rolling continuity cards with roughly a 30-day horizon. It does not control active task state or automatically steer the current conversation.</p><div className="curator-mode" role="radiogroup" aria-label="Tiddle Signal model source"><label><input type="radio" name="curator-mode" checked={mode === 'external'} disabled={disabled} onChange={() => setMode('external')} /> Existing model connection</label><label><input type="radio" name="curator-mode" checked={mode === 'local'} disabled={disabled} onChange={() => setMode('local')} /> Local GGUF</label></div>{mode === 'external' ? <div className="curator-model-row"><ProviderModelFields providers={savedProviders} connectionId={externalValue ? (JSON.parse(externalValue) as { connectionId: string }).connectionId : null} model={externalValue ? (JSON.parse(externalValue) as { model: string }).model : null} disabled={disabled} onChange={(connectionId, model) => setExternalValue(connectionId ? JSON.stringify({ connectionId, model: model ?? '' }) : '')} />{temperatureControl}</div> : <><Field label="Model path"><input value={localPath} onChange={(event) => setLocalPath(event.target.value)} placeholder="models/LFM2.5-2.6B-Q4_K_M.gguf" disabled={disabled} /></Field><div className="field-pair compact-fields"><Field label="Context size"><input type="number" min="1" step="1" value={contextSize} onChange={(event) => setContextSize(event.target.value)} disabled={disabled} /></Field><Field label="GPU layers"><input type="number" min="0" step="1" value={gpuLayers} onChange={(event) => setGpuLayers(event.target.value)} disabled={disabled} /></Field></div>{temperatureControl}</>}<p className="hint" id="tiddle-temperature-help">Controls how much variation Tiddle Signal uses when creating continuity cards. Lower values are more consistent; higher values are warmer and more varied. {status?.configured ? 'Temperature saves after adjustment for the saved model; other model edits require Save Tiddle Settings.' : 'Choose and save a model before temperature can save independently.'}</p>{status && <p className={`curator-status ${status.available ? 'available' : 'unavailable'}`}>{status.available ? 'Available' : 'Unavailable'}{status.reason ? ` · ${status.reason}` : ''}{status.root ? ` · root: ${status.root}` : ''}</p>}{mode === 'external' && externalOptions.length === 0 && <p className="settings-request-error" role="alert">Add a model connection before selecting an external curator model.</p>}{requestState === 'error' && <button type="button" onClick={() => setRetry(value => value + 1)}>Retry Tiddle Settings</button>}{requestState === 'saving' && <p role="status">Saving Tiddle settings…</p>}{baseline && snapshot !== baseline && requestState === 'idle' && <p role="status">Unsaved Tiddle settings changes.</p>}{notice && <p role="status">{notice}</p>}{temperatureFailed && requestState === 'idle' && <button type="button" className="secondary" onClick={() => void saveTemperature()}>Retry saving Tiddle temperature</button>}{error && <p className="settings-request-error" role="alert">{error}</p>}<button type="button" className="primary" onClick={save} disabled={disabled || (status?.configured && snapshot === baseline)}>{requestState === 'saving' ? 'Saving…' : 'Save Tiddle Settings'}</button></div></SettingSection>;
}
