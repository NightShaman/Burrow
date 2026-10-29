import { useEffect, useRef, useState } from 'react';
import { api } from '../../app/api';
import { isUnsavedChangesModalTarget, useUnsavedChanges } from '../../app/UnsavedChanges';
import { Field } from './SettingsPrimitives';

type MaxDepth = 0 | 1 | 2;
type MinionSettingsResponse = { ok: true; maxDepth: MaxDepth };
const depthDescriptions: Record<MaxDepth, string> = {
  0: 'No minions. This agent cannot spawn minions.',
  1: 'Direct minions only. Minions cannot spawn their own minions. (Default)',
  2: 'Nested minions. Direct minions can spawn one further level of minions.',
};
function responseDepth(result: MinionSettingsResponse): MaxDepth {
  if (result.ok !== true || ![0, 1, 2].includes(result.maxDepth)) throw new Error('Invalid minion settings response');
  return result.maxDepth;
}

// AgentSettings keys this form by the full UI identity, including target scope.
export function MinionDepthSettings({ resourceId }: { resourceId: string }) {
  const [maxDepth, setMaxDepth] = useState<MaxDepth>(1);
  const [baseline, setBaseline] = useState<MaxDepth>(1);
  const [state, setState] = useState<'loading' | 'idle' | 'saving' | 'error'>('loading');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [retry, setRetry] = useState(0);
  const owner = useRef<object>({});
  const busy = useRef(false);
  const draft = useRef<MaxDepth>(1);
  const interaction = useRef(false);
  const path = `/api/agents/${encodeURIComponent(resourceId)}/minion-settings`;
  useEffect(() => {
    const token = {}; owner.current = token;
    const controller = new AbortController();
    busy.current = false; draft.current = 1; interaction.current = false;
    setMaxDepth(1); setBaseline(1); setState('loading'); setError(''); setSaved(false);
    api<MinionSettingsResponse>(path, { signal: controller.signal }).then(result => {
      if (owner.current !== token) return;
      const depth = responseDepth(result);
      draft.current = depth; setMaxDepth(depth); setBaseline(depth); setState('idle');
    }).catch(cause => {
      if (owner.current !== token) return;
      setError(`Could not load minion depth: ${cause instanceof Error ? cause.message : 'Unknown error'}`); setState('error');
    });
    return () => { owner.current = {}; controller.abort(); };
  }, [path, retry]);
  const dirty = (state === 'idle' || state === 'saving') && maxDepth !== baseline;
  const save = async (value = draft.current) => {
    if (state !== 'idle' || busy.current) return false;
    if (value === baseline) return true;
    busy.current = true;
    const token = owner.current;
    setState('saving'); setError(''); setSaved(false);
    try {
      const result = await api<MinionSettingsResponse>(path, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ maxDepth: value }) });
      if (owner.current !== token) return false;
      const depth = responseDepth(result);
      draft.current = depth; setMaxDepth(depth); setBaseline(depth); setSaved(true);
      return true;
    } catch (cause) {
      if (owner.current === token) setError(`Could not save minion depth: ${cause instanceof Error ? cause.message : 'Unknown error'}`);
    } finally {
      if (owner.current === token) { busy.current = false; setState('idle'); }
    }
    return false;
  };
  useUnsavedChanges({ dirty, busy: state === 'saving', resumeAfterAutosave: true, save: () => save(), discard: () => { draft.current = baseline; setMaxDepth(baseline); setError(''); setSaved(false); } });
  return <>
    <Field label={`Maximum minion depth (${maxDepth})`}><input aria-label="Maximum minion depth" aria-valuetext={`${maxDepth}: ${depthDescriptions[maxDepth]}`} type="range" min="0" max="2" step="1" value={maxDepth} disabled={state !== 'idle'}
      onPointerDown={event => { interaction.current = true; event.currentTarget.setPointerCapture?.(event.pointerId); }}
      onPointerUp={() => { interaction.current = false; void save(); }}
      onPointerCancel={() => { if (interaction.current) { interaction.current = false; void save(); } }}
      onLostPointerCapture={() => { if (interaction.current) { interaction.current = false; void save(); } }}
      onKeyDown={event => { if (event.key === 'Escape' && interaction.current) { interaction.current = false; draft.current = baseline; setMaxDepth(baseline); setError(''); setSaved(false); event.preventDefault(); return; } if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) interaction.current = true; }}
      onKeyUp={event => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) { interaction.current = false; void save(); } }}
      onBlur={event => { if (isUnsavedChangesModalTarget(event.relatedTarget)) { interaction.current = false; return; } if (interaction.current) { interaction.current = false; void save(); } }}
      onChange={event => { const value = Number(event.target.value) as MaxDepth; draft.current = value; setMaxDepth(value); setError(''); setSaved(false); if (!interaction.current) void save(value); }} /><span className="minion-depth-marks" aria-hidden="true"><span>0</span><span>1</span><span>2</span></span></Field>
    <p className="settings-description">{depthDescriptions[maxDepth]} Applies to this agent. Existing minion trees cannot gain extra depth.</p>
    {state === 'loading' && <p role="status">Loading minion depth…</p>}
    {state === 'saving' && <p role="status">Saving minion depth…</p>}
    {dirty && state !== 'saving' && <p role="status">Unsaved minion depth changes.</p>}
    {state === 'error' && <button type="button" className="secondary" onClick={() => setRetry(value => value + 1)}>Retry minion depth</button>}
    {error && state === 'idle' && dirty && <button type="button" className="secondary" onClick={() => void save()}>Retry saving minion depth</button>}
    {error && <p className="settings-request-error" role="alert">{error}</p>}
    {saved && <p role="status">Minion depth saved.</p>}
  </>;
}
