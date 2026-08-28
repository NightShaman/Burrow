import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { apiForTarget } from '../../app/api';
import { targetForResource, type ApiTarget } from '../../app/apiTargets';
import { useConfirm } from '../../app/ConfirmDialog';
import { Field, SettingSection } from './SettingsPrimitives';

type ScheduledJob = { id: string; agentId: string; name: string; prompt: string; cron: string; timezone: string; sessionId?: string; enabled: boolean; nextRunAt?: string | null; lastRunAt?: string | null };

export function AgentSchedules({ agentId, targets, overflowTarget }: { agentId: string; targets: ApiTarget[]; overflowTarget?: HTMLElement | null }) {
  const owner = targetForResource(targets, agentId);
  const request = <T,>(path: string, init?: RequestInit) => apiForTarget<T>(owner.target, path, init);
  const confirm = useConfirm();
  const [jobs, setJobs] = useState<ScheduledJob[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState(''); const [prompt, setPrompt] = useState(''); const [cron, setCron] = useState('0 9 * * *'); const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'); const [enabled, setEnabled] = useState(true);
  const [state, setState] = useState<'loading' | 'idle' | 'saving'>('loading'); const [error, setError] = useState('');
  const load = async (signal?: AbortSignal) => {
    try {
      const result = await request<{ jobs: ScheduledJob[] }>(`/api/scheduled-jobs?agentId=${encodeURIComponent(owner.resourceId)}`, { signal });
      if (!signal?.aborted) setJobs(result.jobs ?? []);
    } catch (cause) {
      if (!signal?.aborted) setError(cause instanceof Error ? `Could not load schedules: ${cause.message}` : 'Could not load schedules.');
    } finally { if (!signal?.aborted) setState('idle'); }
  };
  useEffect(() => {
    const controller = new AbortController();
    setState('loading'); setEditingId(null); setError('');
    void load(controller.signal);
    return () => controller.abort();
  }, [owner.target.id, owner.resourceId]);
  const reset = () => { setEditingId(null); setName(''); setPrompt(''); setCron('0 9 * * *'); setTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'); setEnabled(true); setError(''); };
  const edit = (job: ScheduledJob) => { setEditingId(job.id); setName(job.name); setPrompt(job.prompt); setCron(job.cron); setTimezone(job.timezone); setEnabled(job.enabled); setError(''); };
  const save = async () => { if (!name.trim() || !prompt.trim() || !cron.trim() || !timezone.trim()) { setError('Name, prompt, cron, and timezone are required.'); return; } setState('saving'); setError(''); try { await request(editingId ? `/api/scheduled-jobs/${encodeURIComponent(editingId)}` : '/api/scheduled-jobs', { method: editingId ? 'PATCH' : 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...(editingId ? {} : { agentId: owner.resourceId }), name: name.trim(), prompt: prompt.trim(), cron: cron.trim(), timezone: timezone.trim(), enabled }) }); await load(); reset(); } catch (cause) { setError(cause instanceof Error ? `Could not save schedule: ${cause.message}` : 'Could not save schedule.'); setState('idle'); } };
  const remove = async (job: ScheduledJob) => { if (!await confirm({ title: 'Delete scheduled job?', message: `Delete ${job.name}?`, confirmLabel: 'Delete job', tone: 'danger' })) return; try { await request(`/api/scheduled-jobs/${encodeURIComponent(job.id)}`, { method: 'DELETE' }); setJobs(items => items.filter(item => item.id !== job.id)); if (editingId === job.id) reset(); } catch (cause) { setError(cause instanceof Error ? `Could not delete schedule: ${cause.message}` : 'Could not delete schedule.'); } };
  const inventory = state === 'loading' ? <p className="settings-empty">Loading cron jobs…</p> : jobs.length === 0 ? <p className="settings-empty">No cron jobs configured for this agent.</p> : <div className="schedule-list">{jobs.map(job => <article className="schedule-card" key={job.id}><div><strong>{job.name}</strong><small>{job.cron} · {job.timezone}</small><p>{job.prompt}</p></div><div className="card-actions"><button className="secondary" type="button" onClick={() => edit(job)}>Edit</button><button className="danger" type="button" onClick={() => void remove(job)}>Delete</button></div></article>)}</div>;
  const editor = <><p className="settings-description">Run prompts for this agent on a five-field cron schedule.</p><div className="schedule-form"><Field label="Name"><input value={name} onChange={event => setName(event.target.value)} placeholder="Morning briefing" /></Field><Field label="Prompt"><textarea value={prompt} onChange={event => setPrompt(event.target.value)} rows={3} placeholder="Prepare the daily briefing…" /></Field><div className="schedule-field-pair"><Field label="Cron"><input value={cron} onChange={event => setCron(event.target.value)} placeholder="0 9 * * *" /><small className="field-hint">minute hour day month weekday</small></Field><Field label="Timezone"><input value={timezone} onChange={event => setTimezone(event.target.value)} placeholder="America/New_York" /></Field></div><div className="schedule-footer"><label className="schedule-enabled"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} /><span>Enabled</span></label><div className="setting-actions"><button className="secondary" type="button" onClick={reset} disabled={state === 'saving'}>{editingId ? 'Cancel' : 'Clear'}</button><button className="primary" type="button" onClick={() => void save()} disabled={state !== 'idle'}>{state === 'saving' ? 'Saving…' : editingId ? 'Save job' : 'Add job'}</button></div></div></div>{error && <p className="settings-request-error" role="alert">{error}</p>}</>;
  return <><SettingSection title="Cron jobs">{editor}{!overflowTarget && inventory}</SettingSection>{overflowTarget && createPortal(<div className="settings-overflow-content"><SettingSection title="Saved cron jobs">{inventory}</SettingSection></div>, overflowTarget)}</>;
}

