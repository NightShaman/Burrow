import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, jsonMutation } from '../../app/api';
import { useConfirm } from '../../app/ConfirmDialog';
import { useUnsavedChanges, useUnsavedNavigation } from '../../app/UnsavedChanges';
import { Field, SettingSection } from './SettingsPrimitives';
import { WorkflowReceiverSettings } from './WorkflowReceiverSettings';
import './workflowEvents.css';

export type WorkflowWatch = { id: string; repository: string; workflow: string; agentId: string; sessionId: string; instruction: string; enabled: boolean; createdAt?: string; updatedAt?: string };
export type WorkflowEvent = { id: string; watchId: string; repository: string; workflow: string; runId: string; runAttempt: number; headSha: string; conclusion: string; url: string; completedAt: string; agentId: string; sessionId: string; instruction: string; status: 'pending' | 'running' | 'succeeded' | 'failed' | 'interrupted'; chatRunId?: string | null; result?: unknown; error?: string | null; createdAt: string; startedAt?: string | null; finishedAt?: string | null };
type Draft = Pick<WorkflowWatch, 'repository' | 'workflow' | 'sessionId' | 'instruction' | 'enabled'>;
const emptyDraft = (): Draft => ({ repository: '', workflow: '', sessionId: 'ci-releases', instruction: '', enabled: false });
const draftFor = ({ repository, workflow, sessionId, instruction, enabled }: WorkflowWatch): Draft => ({ repository, workflow, sessionId, instruction, enabled });
const message = (cause: unknown) => cause instanceof Error ? cause.message : 'Request failed.';
export function githubRunUrl(value: string): string | undefined {
  try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === 'github.com' ? url.href : undefined; } catch { return undefined; }
}
function eventTime(value: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(); }

export function AgentWorkflowEvents({ agentId, overflowTarget }: { agentId: string; overflowTarget?: HTMLElement | null }) {
  const resourceId = agentId.includes('::') ? agentId.slice(agentId.indexOf('::') + 2) : agentId;
  // Keying the inner editor gives every destination its own request lifetime.
  return <WorkflowEditor key={resourceId} agentId={resourceId} overflowTarget={overflowTarget} />;
}
function WorkflowEditor({ agentId, overflowTarget }: { agentId: string; overflowTarget?: HTMLElement | null }) {
  const confirm = useConfirm();
  const navigate = useUnsavedNavigation();
  const [watches, setWatches] = useState<WorkflowWatch[]>([]);
  const [events, setEvents] = useState<WorkflowEvent[]>([]);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [baseline, setBaseline] = useState<Draft>(emptyDraft);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [watchError, setWatchError] = useState('');
  const [eventError, setEventError] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const lifetime = useRef(new AbortController());
  const lock = useRef(false);
  const firstInput = useRef<HTMLInputElement>(null);
  const loadWatches = async () => {
    const { signal } = lifetime.current;
    try {
      const result = await api<{ ok: boolean; watches: WorkflowWatch[] }>('/api/events/watches', { signal });
      if (!result.ok || !Array.isArray(result.watches)) throw new Error('Invalid watches response.');
      if (!signal.aborted) { setWatches(result.watches.filter(watch => watch.agentId === agentId)); setWatchError(''); }
    } catch (cause) { if (!signal.aborted) setWatchError(`Could not load watches: ${message(cause)}`); }
    finally { if (!signal.aborted) setLoading(false); }
  };
  const loadEvents = async () => {
    const { signal } = lifetime.current;
    try {
      const result = await api<{ ok: boolean; events: WorkflowEvent[] }>(`/api/events?agentId=${encodeURIComponent(agentId)}&limit=50`, { signal });
      if (!result.ok || !Array.isArray(result.events)) throw new Error('Invalid events response.');
      if (!signal.aborted) { setEvents(result.events.filter(event => event.agentId === agentId)); setEventError(''); }
    } catch (cause) { if (!signal.aborted) setEventError(`Could not load recent events: ${message(cause)}`); }
  };
  useEffect(() => {
    lifetime.current = new AbortController();
    void loadWatches(); void loadEvents();
    const timer = window.setInterval(() => { if (document.visibilityState !== 'hidden') void loadEvents(); }, 15000);
    return () => { lifetime.current.abort(); window.clearInterval(timer); };
  }, []);
  const choose = (watch?: WorkflowWatch) => {
    const next = watch ? draftFor(watch) : emptyDraft();
    setDraft(next); setBaseline(next); setEditingId(watch?.id ?? null); setError(''); setNotice(''); firstInput.current?.focus();
  };
  const update = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft(previous => ({ ...previous, [key]: value }));
  const post = async (value: Draft, id?: string | null) => {
    const result = await api<{ ok: boolean; watch: WorkflowWatch }>('/api/events/watches', jsonMutation('POST', { ...value, ...(id ? { id } : {}), agentId }));
    if (!result.ok || !result.watch?.id) throw new Error('Watch was not saved.');
    return result.watch;
  };
  const save = async (): Promise<boolean> => {
    if (lock.current || loading || watchError) return false;
    if (!/^[^/\s]+\/[^/\s]+$/.test(draft.repository.trim()) || !draft.workflow.trim() || !draft.sessionId.trim() || !draft.instruction.trim()) { setError('Enter owner/repo, the exact workflow name, a destination session, and an instruction.'); return false; }
    lock.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const watch = await post({ ...draft, repository: draft.repository.trim(), workflow: draft.workflow.trim(), sessionId: draft.sessionId.trim(), instruction: draft.instruction.trim() }, editingId);
      if (lifetime.current.signal.aborted) return false;
      setWatches(items => [watch, ...items.filter(item => item.id !== watch.id)]);
      const next = draftFor(watch); setDraft(next); setBaseline(next); setEditingId(watch.id); setNotice('Watch saved.'); return true;
    } catch (cause) { if (!lifetime.current.signal.aborted) setError(`Could not save watch: ${message(cause)}`); return false; }
    finally { lock.current = false; if (!lifetime.current.signal.aborted) setBusy(false); }
  };
  useUnsavedChanges({ dirty: JSON.stringify(draft) !== JSON.stringify(baseline), busy, save, discard: () => setDraft(baseline) });
  const toggle = async (watch: WorkflowWatch) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const saved = await post({ ...draftFor(watch), enabled: !watch.enabled }, watch.id);
      if (lifetime.current.signal.aborted) return;
      setWatches(items => items.map(item => item.id === saved.id ? saved : item));
      if (editingId === saved.id) { setDraft(draftFor(saved)); setBaseline(draftFor(saved)); }
      setNotice(saved.enabled ? 'Watch enabled.' : 'Watch disabled.');
    } catch (cause) { if (!lifetime.current.signal.aborted) setError(`Could not update watch: ${message(cause)}`); }
    finally { lock.current = false; if (!lifetime.current.signal.aborted) setBusy(false); }
  };
  const remove = async (watch: WorkflowWatch) => {
    if (lock.current || !await confirm({ title: 'Delete workflow watch?', message: `Stop watching ${watch.repository} · ${watch.workflow}? Recent events are retained.`, confirmLabel: 'Delete watch', tone: 'danger' }) || lifetime.current.signal.aborted) return;
    lock.current = true; setBusy(true); setError('');
    try {
      const result = await api<{ ok: boolean }>(`/api/events/watches/${encodeURIComponent(watch.id)}`, jsonMutation('DELETE'));
      if (!result.ok) throw new Error('Watch was not deleted.');
      if (lifetime.current.signal.aborted) return;
      setWatches(items => items.filter(item => item.id !== watch.id)); if (editingId === watch.id) choose(); setNotice('Watch deleted.');
    } catch (cause) { if (!lifetime.current.signal.aborted) setError(`Could not delete watch: ${message(cause)}`); }
    finally { lock.current = false; if (!lifetime.current.signal.aborted) setBusy(false); }
  };
  const inventory = <>
    <SettingSection title="Saved watches">
      {loading ? <p role="status">Loading watches…</p> : watchError ? <p className="settings-request-error" role="alert">{watchError} <button type="button" onClick={() => void loadWatches()}>Retry</button></p> : watches.length ? <div className="schedule-list">{watches.map(watch => <article className="schedule-card workflow-watch" key={watch.id}>
        <button type="button" className="schedule-card-select schedule-card-details" aria-pressed={editingId === watch.id} disabled={busy} onClick={() => navigate(() => choose(watch))}><strong>{watch.workflow}</strong><small>{watch.repository}</small><small>{watch.enabled ? 'Enabled' : 'Disabled'} · {watch.sessionId}</small></button>
        <div className="schedule-card-actions"><button type="button" className="secondary" disabled={busy} onClick={() => navigate(() => void toggle(watch))}>{watch.enabled ? 'Disable' : 'Enable'}</button><button type="button" className="danger" disabled={busy} onClick={() => navigate(() => void remove(watch))}>Delete</button></div>
      </article>)}</div> : <p className="settings-empty">No watches for this agent.</p>}
    </SettingSection>
    <SettingSection title="Recent events">
      <div className="setting-actions"><button type="button" className="secondary" onClick={() => void loadEvents()}>Refresh events</button></div>
      {eventError ? <p className="settings-request-error" role="alert">{eventError}</p> : null}
      {!events.length && !eventError ? <p className="settings-empty">{loading ? 'Loading events…' : 'No events for this agent.'}</p> : <div className="workflow-event-list">{events.map(event => <article className="workflow-event-card" key={event.id}>
        <strong>{event.workflow}</strong><span>{event.repository}</span>
        <div className="workflow-event-status"><span>GitHub: <b>{event.conclusion || 'unknown'}</b></span><span>Burrow handling: <b>{event.status}</b></span></div>
        <small>{event.sessionId} · {eventTime(event.completedAt || event.createdAt)}</small>
        {githubRunUrl(event.url) ? <a href={githubRunUrl(event.url)} target="_blank" rel="noreferrer">GitHub run #{event.runId} · attempt {event.runAttempt}</a> : <span>Run #{event.runId} · attempt {event.runAttempt}</span>}
        {event.error && <p className="settings-request-error">{event.error}</p>}
        <details><summary>Event details</summary><dl><dt>Commit</dt><dd>{event.headSha}</dd><dt>Instruction</dt><dd>{event.instruction}</dd>{event.chatRunId && <><dt>Burrow run</dt><dd>{event.chatRunId}</dd></>}{event.finishedAt && <><dt>Finished</dt><dd>{eventTime(event.finishedAt)}</dd></>}{event.result != null && <><dt>Result</dt><dd><pre>{typeof event.result === 'string' ? event.result : JSON.stringify(event.result, null, 2)}</pre></dd></>}</dl></details>
      </article>)}</div>}
    </SettingSection>
  </>;
  return <><SettingSection title="Workflow events">
    <p className="settings-description">Run an instruction when a GitHub workflow completes.</p>
    <div className="schedule-form"><div className="schedule-field-pair"><Field label="Repository"><input ref={firstInput} value={draft.repository} onChange={event => update('repository', event.target.value)} placeholder="owner/repo" disabled={busy} /></Field><Field label="Workflow name"><input value={draft.workflow} onChange={event => update('workflow', event.target.value)} placeholder="CI" disabled={busy} /><small className="field-hint">Exact GitHub workflow name, not the filename.</small></Field></div><Field label="Destination session"><input value={draft.sessionId} onChange={event => update('sessionId', event.target.value)} disabled={busy} /></Field><Field label="Instruction"><textarea rows={4} value={draft.instruction} onChange={event => update('instruction', event.target.value)} placeholder="Inspect the completed run and report the result…" disabled={busy} /></Field>
    <div className="schedule-footer"><label className="schedule-enabled"><input type="checkbox" checked={draft.enabled} onChange={event => update('enabled', event.target.checked)} disabled={busy} /><span>Enabled</span></label><div className="setting-actions"><button type="button" className="secondary" onClick={() => navigate(() => choose())} disabled={busy}>{editingId ? 'New watch' : 'Clear'}</button><button type="button" className="primary" onClick={() => void save()} disabled={busy || loading || Boolean(watchError)}>{busy ? 'Saving…' : editingId ? 'Save watch' : 'Add watch'}</button></div></div></div>
    {error && <p className="settings-request-error" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    <details className="workflow-setup"><summary>GitHub webhook setup</summary><p>Point a GitHub repository webhook at <code>/api/events/github</code>, select <code>workflow_run</code> events, and use JSON payloads. Use the same secret configured in the global receiver above. Burrow verifies each delivery signature; the secret is never returned to this form.</p><p>GitHub conclusion describes the workflow. Burrow handling describes the agent work it triggered. Open the destination session for existing live activity and conversation history.</p></details>
    </SettingSection><WorkflowReceiverSettings />{overflowTarget ? createPortal(<div className="settings-overflow-content">{inventory}</div>, overflowTarget) : inventory}</>;
}
