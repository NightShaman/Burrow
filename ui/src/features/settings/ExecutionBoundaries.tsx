import { useEffect, useState } from 'react';
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

export function ExecutionBoundaries() {
  const [hardBlocks, setHardBlocks] = useState<ExecutionBoundary[]>([]);
  const [status, setStatus] = useState<'loading' | 'idle' | 'saving'>('loading');
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    void executionBoundariesApi.load(controller.signal).then((result) => {
      setHardBlocks(result.boundaries.hardBlocks);
    }).catch((cause) => {
      if (controller.signal.aborted) return;
      setError(cause instanceof Error ? `Could not load execution boundaries: ${cause.message}` : 'Could not load execution boundaries.');
    }).finally(() => {
      if (!controller.signal.aborted) setStatus('idle');
    });
    return () => controller.abort();
  }, []);

  const update = (index: number, changes: Partial<ExecutionBoundary>) => setHardBlocks((rules) => rules.map((rule, ruleIndex) => ruleIndex === index ? { ...rule, ...changes } : rule));
  const toggleOperation = (index: number, operation: BoundaryOperation) => setHardBlocks((rules) => rules.map((rule, ruleIndex) => ruleIndex !== index ? rule : {
    ...rule,
    operations: rule.operations.includes(operation) ? rule.operations.filter((item) => item !== operation) : [...rule.operations, operation],
  }));
  const save = async () => {
    setStatus('saving');
    setError('');
    try {
      const result = await executionBoundariesApi.save(hardBlocks);
      setHardBlocks(result.boundaries.hardBlocks);
    } catch (cause) {
      setError(cause instanceof Error ? `Could not save execution boundaries: ${cause.message}` : 'Could not save execution boundaries.');
    } finally {
      setStatus('idle');
    }
  };

  return <SettingSection title="Execution boundaries">
    <p className="settings-section-description">Hard blocks are enforced immediately before tool execution. Matching path or command operations cannot proceed.</p>
    <div className="boundary-rules">
      {hardBlocks.map((rule, index) => <article className="boundary-rule" key={`${rule.id}-${index}`}>
        <div className="boundary-rule-heading">
          <label className="boundary-enabled"><input type="checkbox" checked={rule.enabled} onChange={(event) => update(index, { enabled: event.target.checked })} /> Enabled</label>
          <button className="boundary-remove" type="button" onClick={() => setHardBlocks((rules) => rules.filter((_, ruleIndex) => ruleIndex !== index))} aria-label={`Remove ${rule.id || 'boundary'}`}>Remove</button>
        </div>
        <div className="field-pair compact-fields">
          <Field label="Rule ID"><input value={rule.id} onChange={(event) => update(index, { id: event.target.value })} placeholder="backup-readonly" /></Field>
          <Field label="Target type"><select value={rule.type} onChange={(event) => update(index, { type: event.target.value as ExecutionBoundary['type'], match: event.target.value === 'command' ? 'regex' : 'glob' })}><option value="path">Path</option><option value="command">Command</option></select></Field>
        </div>
        <Field label="Pattern"><input value={rule.pattern} onChange={(event) => update(index, { pattern: event.target.value })} placeholder={rule.type === 'path' ? '/mnt/backup/**' : 'rm\\s'} /></Field>
        <div className="field-pair compact-fields">
          <Field label="Match"><select value={rule.match} onChange={(event) => update(index, { match: event.target.value as ExecutionBoundary['match'] })}>{boundaryMatches.map((match) => <option key={match} value={match}>{match}</option>)}</select></Field>
          <Field label="Reason"><input value={rule.reason ?? ''} onChange={(event) => update(index, { reason: event.target.value })} placeholder="Optional" /></Field>
        </div>
        <fieldset className="boundary-operations"><legend>Block operations</legend>{boundaryOperations.map((operation) => <label key={operation}><input type="checkbox" checked={rule.operations.includes(operation)} onChange={() => toggleOperation(index, operation)} /> {operation}</label>)}</fieldset>
      </article>)}
      {hardBlocks.length === 0 && <p className="boundary-empty">No hard blocks are configured.</p>}
    </div>
    <div className="boundary-actions">
      <button className="secondary" type="button" onClick={() => setHardBlocks((rules) => [...rules, newBoundary()])} disabled={status === 'loading'}>Add hard block</button>
      <button className="primary" type="button" onClick={() => void save()} disabled={status !== 'idle'}>{status === 'saving' ? 'Saving…' : 'Save boundaries'}</button>
    </div>
    {error && <p className="settings-request-error" role="alert">{error}</p>}
  </SettingSection>;
}
