import { useEffect, useRef, useState } from 'react';
import { api } from '../../app/api';
import type { SavedProvider } from '../../app/types';
import { defaultReasoningEffort, reasoningEffortsForModel } from '../../app/modelSelectionOptions';
import { Field } from './SettingsPrimitives';

type Selection = { connectionId: string; model: string; reasoningEffort: string; temperature?: number } | null;

// Keyed by the full UI identity at the mount boundary, not just the resource ID.
export function DefaultMinionModel({ resourceId, savedProviders }: { resourceId: string; savedProviders: SavedProvider[] }) {
  const [selection, setSelection] = useState<Selection>(null);
  const [state, setState] = useState<'loading' | 'idle' | 'saving' | 'error'>('loading');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [retry, setRetry] = useState(0);
  const owner = useRef<object>({});
  const busy = useRef(false);
  const path = `/api/agents/${encodeURIComponent(resourceId)}/minion-model-selection`;
  useEffect(() => {
    const token = {}; owner.current = token;
    const controller = new AbortController();
    setState('loading'); setError(''); setSaved(false);
    api<{ selection: Selection }>(path, { signal: controller.signal }).then(result => {
      if (owner.current !== token) return;
      setSelection(result.selection); setState('idle');
    }).catch(cause => {
      if (owner.current !== token) return;
      setError(`Could not load default minion model: ${cause instanceof Error ? cause.message : 'Unknown error'}`); setState('error');
    });
    return () => { owner.current = {}; controller.abort(); };
  }, [path, retry]);
  const provider = savedProviders.find(item => item.id === selection?.connectionId);
  const available = !selection || Boolean(provider?.models.includes(selection.model));
  const efforts = reasoningEffortsForModel(provider, selection?.model ?? '');
  const change = (next: Selection) => { setSelection(next); setSaved(false); setError(''); };
  const save = async () => {
    if (state !== 'idle' || busy.current || !available) return;
    busy.current = true;
    const token = owner.current;
    setState('saving'); setError(''); setSaved(false);
    try {
      const result = await api<{ selection: Selection }>(path, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(selection ?? { connectionId: null, model: null }) });
      if (owner.current === token) { setSelection(result.selection); setSaved(true); }
    } catch (cause) {
      if (owner.current === token) setError(`Could not save default minion model: ${cause instanceof Error ? cause.message : 'Unknown error'}`);
    } finally {
      busy.current = false;
      if (owner.current === token) setState('idle');
    }
  };
  const disabled = state !== 'idle';
  return <>
    <Field label="Default Minion Model"><select disabled={disabled} value={selection ? JSON.stringify([selection.connectionId, selection.model]) : ''} onChange={event => {
      if (!event.target.value) { change(null); return; }
      const [connectionId, model] = JSON.parse(event.target.value) as [string, string];
      const next = savedProviders.find(item => item.id === connectionId);
      change({ connectionId, model, reasoningEffort: defaultReasoningEffort(next, model), temperature: selection?.temperature ?? 0.2 });
    }}>
      <option value="">Inherit current parent turn</option>
      {!available && selection && <option value={JSON.stringify([selection.connectionId, selection.model])}>Unavailable · {selection.connectionId} · {selection.model}</option>}
      {savedProviders.flatMap(item => item.models.map(model => <option key={JSON.stringify([item.id, model])} value={JSON.stringify([item.id, model])}>{item.provider} · {item.id} · {item.modelLabels?.[model] ?? model}</option>))}
    </select></Field>
    <p className="settings-description">Used when this agent spawns a minion. Inherit uses the current parent turn’s model selection. An explicit spawn model overrides this default.</p>
    {state === 'loading' && <p role="status">Loading default minion model…</p>}
    {!available && <p className="settings-help">The saved connection or model is unavailable. Choose an available model or inherit; no replacement has been selected automatically.</p>}
    {selection && <div className="field-pair">
      <Field label="Minion reasoning effort"><select value={selection.reasoningEffort} disabled={disabled || !available} onChange={event => change({ ...selection, reasoningEffort: event.target.value })}>
        {!efforts.includes(selection.reasoningEffort) && <option value={selection.reasoningEffort}>Unavailable · {selection.reasoningEffort}</option>}
        {efforts.map(effort => <option key={effort} value={effort}>{effort}</option>)}
      </select></Field>
      <Field label={`Minion temperature${selection.temperature === undefined ? ' (runtime default)' : ` (${selection.temperature})`}`}><input aria-label="Minion temperature" type="range" min="0" max="2" step="0.1" value={selection.temperature ?? 0.2} disabled={disabled || !available} onChange={event => change({ ...selection, temperature: Number(event.target.value) })} /></Field>
    </div>}
    <div className="model-actions"><button type="button" className="primary" disabled={disabled || !available} onClick={() => void save()}>{state === 'saving' ? 'Saving minion model…' : 'Save minion model'}</button>{state === 'error' && <button type="button" className="secondary" onClick={() => setRetry(value => value + 1)}>Retry minion model</button>}</div>
    {error && <p className="settings-request-error" role="alert">{error}</p>}
    {saved && <p role="status">Default minion model saved.</p>}
  </>;
}
