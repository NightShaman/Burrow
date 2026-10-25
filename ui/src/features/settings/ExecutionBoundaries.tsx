import { useUnsavedChanges, useUnsavedNavigation } from '../../app/UnsavedChanges';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../../app/api';
import { Field, SettingSection } from './SettingsPrimitives';

export type BoundaryOperation = 'read' | 'write' | 'delete' | 'execute' | 'delegate';
export type ExecutionBoundary = {
  id: string;
  enabled: boolean;
  type: 'path' | 'command';
  pattern: string;
  match: 'exact' | 'prefix' | 'glob' | 'regex' | 'contains';
  operations: BoundaryOperation[];
  reason?: string;
};

type ExecutionBoundariesResponse = {
  boundaries: { version: 1; hardBlocks: ExecutionBoundary[] };
  status?: { enabled?: boolean; hardBlockCount?: number; enabledHardBlockCount?: number };
};

const boundaryOperations: BoundaryOperation[] = ['read', 'write', 'delete', 'execute', 'delegate'];
const boundaryMatches: ExecutionBoundary['match'][] = ['exact', 'prefix', 'glob', 'regex', 'contains'];
const newBoundary = (): ExecutionBoundary => ({ id: '', enabled: true, type: 'path', pattern: '', match: 'glob', operations: ['write'] });

export const executionBoundariesApi = {
  load(signal?: AbortSignal) {
    return api<ExecutionBoundariesResponse>('/api/settings/execution-boundaries', { signal });
  },
  save(hardBlocks: ExecutionBoundary[]) {
    return api<ExecutionBoundariesResponse>('/api/settings/execution-boundaries', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hardBlocks }),
    });
  },
};

export function ExecutionBoundaries({ overflowTarget }: { overflowTarget?: HTMLElement | null } = {}) {
  const [hardBlocks, setHardBlocks] = useState<ExecutionBoundary[]>([]);
  const [baseline, setBaseline] = useState<ExecutionBoundary[]>([]);
  const navigate = useUnsavedNavigation();
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [status, setStatus] = useState<'loading' | 'idle' | 'saving' | 'error'>('loading');
  const [error, setError] = useState('');

  const [retry, setRetry] = useState(0);
  useEffect(() => {
    setStatus('loading'); setError('');
    const controller = new AbortController();
    void executionBoundariesApi.load(controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setHardBlocks(result.boundaries.hardBlocks); setBaseline(result.boundaries.hardBlocks);
      setStatus('idle');
    }).catch((cause) => {
      if (controller.signal.aborted) return;
      setStatus('error');
      setError(cause instanceof Error ? `Could not load execution boundaries: ${cause.message}` : 'Could not load execution boundaries.');
    });
    return () => controller.abort();
  }, [retry]);

  const update = (index: number, changes: Partial<ExecutionBoundary>) => setHardBlocks((rules) => rules.map((rule, ruleIndex) => ruleIndex === index ? { ...rule, ...changes } : rule));
  const toggleOperation = (index: number, operation: BoundaryOperation) => setHardBlocks((rules) => rules.map((rule, ruleIndex) => ruleIndex !== index ? rule : {
    ...rule,
    operations: rule.operations.includes(operation) ? rule.operations.filter((item) => item !== operation) : [...rule.operations, operation],
  }));
  const save = async () => {
    if (status !== 'idle') return false;
    setStatus('saving');
    setError('');
    try {
      const result = await executionBoundariesApi.save(hardBlocks);
      setHardBlocks(result.boundaries.hardBlocks); setBaseline(result.boundaries.hardBlocks);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? `Could not save execution boundaries: ${cause.message}` : 'Could not save execution boundaries.');
      return false;
    } finally {
      setStatus('idle');
    }
  };

  useUnsavedChanges({ dirty: status !== 'loading' && status !== 'error' && JSON.stringify(hardBlocks) !== JSON.stringify(baseline), busy: status === 'saving', save, discard: () => { setHardBlocks(baseline); setError(''); if (selectedIndex !== null && selectedIndex >= baseline.length) setSelectedIndex(null); } });
  const selected = selectedIndex === null ? null : hardBlocks[selectedIndex] ?? null;
  const inventory = <div className="settings-overflow-content memory-saved">
    <SettingSection title="Saved rules">
      {status === 'loading' ? <p className="settings-empty">Loading rules…</p> : hardBlocks.length === 0 ? <p className="settings-empty">No hard blocks are configured.</p> :
        <div className="memory-connection-list">{hardBlocks.map((rule, index) => <article className="memory-connection" key={index}>
          <button type="button" className="boundary-inventory-select" aria-pressed={selectedIndex === index} onClick={() => { if (selectedIndex !== index) navigate(() => setSelectedIndex(index)); }}>
            <strong>{rule.id || 'New boundary'}</strong><small>{rule.type} · {rule.pattern || 'No pattern'} · {rule.enabled ? 'Enabled' : 'Disabled'}</small>
          </button>
        </article>)}</div>}
    </SettingSection>
  </div>;

  return <><SettingSection title="Execution boundaries">
    <p className="settings-section-description">Hard blocks are enforced immediately before tool execution. Matching path or command operations cannot proceed.</p>
    {selected && selectedIndex !== null ? <div className="boundary-rules"><div className="boundary-rule">
      <div className="boundary-rule-heading">
        <label className="boundary-enabled"><input type="checkbox" checked={selected.enabled} disabled={status !== 'idle'} onChange={(event) => update(selectedIndex, { enabled: event.target.checked })} /> Enabled</label>
        <button className="boundary-remove" type="button" disabled={status !== 'idle'} onClick={() => { setHardBlocks((rules) => rules.filter((_, index) => index !== selectedIndex)); setSelectedIndex(null); }} aria-label={`Remove ${selected.id || 'boundary'}`}>Remove</button>
      </div>
      <div className="field-pair compact-fields">
        <Field label="Rule ID"><input value={selected.id} disabled={status !== 'idle'} onChange={(event) => update(selectedIndex, { id: event.target.value })} placeholder="backup-readonly" /></Field>
        <Field label="Target type"><select value={selected.type} disabled={status !== 'idle'} onChange={(event) => update(selectedIndex, { type: event.target.value as ExecutionBoundary['type'], match: event.target.value === 'command' ? 'regex' : 'glob' })}><option value="path">Path</option><option value="command">Command</option></select></Field>
      </div>
      <Field label="Pattern"><input value={selected.pattern} disabled={status !== 'idle'} onChange={(event) => update(selectedIndex, { pattern: event.target.value })} placeholder={selected.type === 'path' ? '/mnt/backup/**' : 'rm\\s'} /></Field>
      <div className="field-pair compact-fields">
        <Field label="Match"><select value={selected.match} disabled={status !== 'idle'} onChange={(event) => update(selectedIndex, { match: event.target.value as ExecutionBoundary['match'] })}>{boundaryMatches.map((match) => <option key={match} value={match}>{match}</option>)}</select></Field>
        <Field label="Reason"><input value={selected.reason ?? ''} disabled={status !== 'idle'} onChange={(event) => update(selectedIndex, { reason: event.target.value })} placeholder="Optional" /></Field>
      </div>
      <fieldset className="boundary-operations"><legend>Block operations</legend>{boundaryOperations.map((operation) => <label key={operation}><input type="checkbox" checked={selected.operations.includes(operation)} disabled={status !== 'idle'} onChange={() => toggleOperation(selectedIndex, operation)} /> {operation}</label>)}</fieldset>
    </div></div> : <p className="settings-empty">Select a saved rule or add a hard block.</p>}
    <div className="boundary-actions">
      <button className="secondary" type="button" onClick={() => { setHardBlocks((rules) => { setSelectedIndex(rules.length); return [...rules, newBoundary()]; }); }} disabled={status !== 'idle'}>Add hard block</button>
      <button className="primary" type="button" onClick={() => void save()} disabled={status !== 'idle'}>{status === 'saving' ? 'Saving…' : 'Save boundaries'}</button>
    </div>
    {status === 'error' && <button onClick={() => setRetry(value => value + 1)}>Retry</button>}
    {error && <p className="settings-request-error" role="alert">{error}</p>}
    {!overflowTarget && inventory}
  </SettingSection>{overflowTarget && createPortal(inventory, overflowTarget)}</>;
}
