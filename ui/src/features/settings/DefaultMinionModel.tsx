import { isUnsavedChangesModalTarget, useUnsavedChanges } from '../../app/UnsavedChanges';
import { useEffect, useRef, useState } from 'react';
import { api } from '../../app/api';
import type { SavedProvider } from '../../app/types';
import { defaultReasoningEffort, reasoningEffortsForModel } from '../../app/modelSelectionOptions';
import { Field } from './SettingsPrimitives';
import { ProviderModelFields } from './ProviderModelFields';

type Selection = { connectionId: string; model: string; reasoningEffort: string; temperature?: number } | null;
type Scope = 'identity' | 'reasoningEffort' | 'temperature';
const sameSelection = (left: Selection, right: Selection) => left === right || Boolean(left && right
  && left.connectionId === right.connectionId && left.model === right.model
  && left.reasoningEffort === right.reasoningEffort && left.temperature === right.temperature);

// Read only the editable selection, not server metadata such as updatedAt.
// An absent selection is not an acknowledgement of Inherit: it must be null.
function responseSelection(value: unknown): Selection {
  const response = value as { ok?: unknown; selection?: unknown } | null;
  if (!response || response.ok !== true) throw new Error('Invalid minion model selection response.');
  if (response.selection === null) return null;
  const selection = response.selection as Partial<NonNullable<Selection>> | undefined;
  if (!selection || typeof selection.connectionId !== 'string' || !selection.connectionId.trim()
    || typeof selection.model !== 'string' || !selection.model.trim()
    || typeof selection.reasoningEffort !== 'string' || !selection.reasoningEffort.trim()
    || (selection.temperature !== undefined && (typeof selection.temperature !== 'number'
      || !Number.isFinite(selection.temperature) || selection.temperature < 0 || selection.temperature > 2))) {
    throw new Error('Invalid minion model selection response.');
  }
  return { connectionId: selection.connectionId, model: selection.model, reasoningEffort: selection.reasoningEffort, temperature: selection.temperature };
}

// Keyed by the full UI identity at the mount boundary, not just the resource ID.
export function DefaultMinionModel({ resourceId, savedProviders }: { resourceId: string; savedProviders: SavedProvider[] }) {
  const [selection, setSelection] = useState<Selection>(null);
  const [baseline, setBaseline] = useState<Selection>(null);
  const [state, setState] = useState<'loading' | 'idle' | 'saving' | 'error'>('loading');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [failures, setFailures] = useState<Partial<Record<Scope, string>>>({});
  const [retry, setRetry] = useState(0);
  const owner = useRef<object>({});
  const busy = useRef(false);
  const draft = useRef<Selection>(null);
  // Keep the model choice and its default effort as one captured intent. Later
  // independent effort edits must not silently rewrite a failed identity retry.
  const identityIntent = useRef<Selection | undefined>(undefined);
  const temperatureInteraction = useRef(false);
  const path = `/api/agents/${encodeURIComponent(resourceId)}/minion-model-selection`;
  useEffect(() => {
    const token = {}; owner.current = token;
    const controller = new AbortController();
    busy.current = false; draft.current = null; identityIntent.current = undefined; temperatureInteraction.current = false;
    setSelection(null); setBaseline(null); setState('loading'); setError(''); setSaved(false); setFailures({});
    api<unknown>(path, { signal: controller.signal }).then(result => {
      if (owner.current !== token) return;
      const loaded = responseSelection(result);
      draft.current = loaded;
      setSelection(loaded); setBaseline(loaded); setState('idle');
    }).catch(cause => {
      if (owner.current !== token) return;
      setError(`Could not load default minion model: ${cause instanceof Error ? cause.message : 'Unknown error'}`); setState('error');
    });
    return () => { owner.current = {}; controller.abort(); };
  }, [path, retry]);
  const valid = (value: Selection) => {
    if (!value) return true;
    const selectedProvider = savedProviders.find(item => item.id === value.connectionId);
    return Boolean(value.connectionId && value.model && selectedProvider?.models.includes(value.model));
  };
  const provider = savedProviders.find(item => item.id === selection?.connectionId);
  const available = valid(selection);
  const efforts = reasoningEffortsForModel(provider, selection?.model ?? '');
  const change = (next: Selection) => { draft.current = next; setSelection(next); setSaved(false); setError(''); };
  const save = async (scope: Scope | 'all' = 'all', values = draft.current) => {
    if (state !== 'idle' || busy.current) return false;
    // This endpoint replaces a whole selection. Independent controls must use
    // accepted counterparts, never a failed/incomplete competing identity draft.
    // Retry identity from the intent captured when the model was selected, not
    // from a later independently failed effort draft.
    const intent = scope === 'identity' && values === draft.current && identityIntent.current !== undefined
      ? identityIntent.current : values;
    const value = scope === 'all' ? values : scope === 'identity'
      ? intent && { ...intent, temperature: baseline?.temperature ?? 0.2 }
      : baseline && values && { ...baseline, [scope]: values[scope] };
    if (!valid(value) || (scope !== 'all' && scope !== 'identity' && !baseline)) return false;
    const scopes: Scope[] = scope === 'all' ? ['identity', 'reasoningEffort', 'temperature'] : [scope];
    const clearFailures = () => setFailures(current => {
      const next = { ...current };
      scopes.forEach(key => { delete next[key]; });
      return next;
    });
    if (sameSelection(value, baseline)) {
      if (scope === 'identity' || scope === 'all') identityIntent.current = undefined;
      clearFailures(); return true;
    }
    busy.current = true;
    const token = owner.current;
    setState('saving'); setError(''); setSaved(false);
    try {
      const result = await api<unknown>(path, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value ?? { connectionId: null, model: null }) });
      if (owner.current !== token) return false;
      const accepted = responseSelection(result);
      if ((value === null) !== (accepted === null)
        || (value && accepted && (value.connectionId !== accepted.connectionId || value.model !== accepted.model))) {
        throw new Error('Invalid minion model selection acknowledgement.');
      }
      const current = draft.current;
      const next = scope === 'all' || !accepted || !current ? accepted
        : scope === 'identity' ? {
          ...accepted,
          reasoningEffort: current.reasoningEffort === value?.reasoningEffort ? accepted.reasoningEffort : current.reasoningEffort,
          temperature: current.temperature === baseline?.temperature ? accepted.temperature : current.temperature,
        }
        : { ...current, [scope]: accepted[scope] };
      draft.current = next;
      if (scope === 'identity' || scope === 'all') identityIntent.current = undefined;
      setSelection(next); setBaseline(accepted); clearFailures();
      // A successful independent write must not announce that a competing
      // identity or another failed field has been saved.
      setSaved(sameSelection(next, accepted));
      return true;
    } catch (cause) {
      if (owner.current === token) {
        const message = `Could not save default minion model: ${cause instanceof Error ? cause.message : 'Unknown error'}`;
        setFailures(current => ({ ...current, ...Object.fromEntries(scopes.map(key => [key, message])) }));
      }
    } finally {
      if (owner.current === token) { busy.current = false; setState('idle'); }
    }
    return false;
  };
  const dirty = (state === 'idle' || state === 'saving') && !sameSelection(selection, baseline);
  useUnsavedChanges({ dirty, busy: state === 'saving', resumeAfterAutosave: true, save: () => save(), discard: () => { draft.current = baseline; identityIntent.current = undefined; temperatureInteraction.current = false; setSelection(baseline); setError(''); setSaved(false); setFailures({}); } });
  const disabled = state !== 'idle';
  const commitTemperature = () => {
    if (!temperatureInteraction.current) return;
    temperatureInteraction.current = false;
    void save('temperature');
  };
  return <>
    <ProviderModelFields providers={savedProviders} connectionId={selection?.connectionId} model={selection?.model} inheritLabel="Inherit current parent turn" disabled={disabled} providerLabel="Default minion provider" modelLabel="Default minion model" onChange={(connectionId, model) => {
      if (!connectionId) { identityIntent.current = null; change(null); void save('identity', null); return; }
      const nextProvider = savedProviders.find(item => item.id === connectionId);
      const next = { connectionId, model: model ?? '', reasoningEffort: defaultReasoningEffort(nextProvider, model ?? ''), temperature: selection?.temperature ?? 0.2 };
      identityIntent.current = next;
      change(next);
      if (valid(next)) void save('identity', next);
    }} />
    <p className="settings-description">Used when this agent spawns a minion. Inherit uses the current parent turn’s model selection. An explicit spawn model overrides this default.</p>
    {state === 'loading' && <p role="status">Loading default minion model…</p>}
    {!available && <p className="settings-help">The saved connection or model is unavailable. Choose an available model or inherit; no replacement has been selected automatically.</p>}
    {selection && <div className="field-pair">
      <Field label="Minion reasoning effort"><select value={selection.reasoningEffort} disabled={disabled || !available || !baseline || !valid(baseline)} onChange={event => { const next = { ...selection, reasoningEffort: event.target.value }; change(next); void save('reasoningEffort', next); }}>
        {!efforts.includes(selection.reasoningEffort) && <option value={selection.reasoningEffort}>Unavailable · {selection.reasoningEffort}</option>}
        {efforts.map(effort => <option key={effort} value={effort}>{effort}</option>)}
      </select></Field>
      <Field label={`Minion temperature${selection.temperature === undefined ? ' (runtime default)' : ` (${selection.temperature})`}`}><input aria-label="Minion temperature" type="range" min="0" max="2" step="0.1" value={selection.temperature ?? 0.2} disabled={disabled || !available || !baseline || !valid(baseline)}
        onPointerDown={event => { temperatureInteraction.current = true; event.currentTarget.setPointerCapture?.(event.pointerId); }}
        onPointerUp={commitTemperature}
        onPointerCancel={commitTemperature}
        onLostPointerCapture={commitTemperature}
        onKeyDown={event => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) temperatureInteraction.current = true; }}
        onKeyUp={event => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) commitTemperature(); }}
        onBlur={event => {
          if (isUnsavedChangesModalTarget(event.relatedTarget)) { temperatureInteraction.current = false; return; }
          commitTemperature();
        }}
        onChange={event => { temperatureInteraction.current = true; change({ ...selection, temperature: Number(event.target.value) }); }} /></Field>
    </div>}
    {state === 'saving' && <p role="status">Saving default minion model…</p>}
    {dirty && state !== 'saving' && <p role="status">Unsaved default minion model changes.</p>}
    {state === 'error' && <button type="button" className="secondary" onClick={() => setRetry(value => value + 1)}>Retry minion model</button>}
    {Object.keys(failures).map(scope => <div key={scope}>
      {state === 'idle' && dirty && <button type="button" className="secondary" onClick={() => void save(scope as Scope)}>Retry saving minion {scope === 'identity' ? 'model' : scope === 'reasoningEffort' ? 'reasoning effort' : 'temperature'}</button>}
    </div>)}
    {[...new Set(Object.values(failures))].map(message => <p key={message} className="settings-request-error" role="alert">{message}</p>)}
    {error && <p className="settings-request-error" role="alert">{error}</p>}
    {saved && <p role="status">Default minion model saved.</p>}
  </>;
}
