import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, jsonMutation } from '../../app/api';
import type { SavedProvider } from '../../app/types';
import { useConfirm } from '../../app/ConfirmDialog';
import { Field, SettingSection } from './SettingsPrimitives';

type JobModel = { modelConnectionId?: string | null; model?: string | null };
type ScheduledJob = { id: string; ownerModId?: string | null; agentId: string; name: string; prompt: string; cron: string; timezone: string | null; effectiveTimezone?: string; sessionId?: string; enabled: boolean; nextRunAt?: string | null; lastRunAt?: string | null } & JobModel;
type ModelOption = { value: string; label: string };

function modelValue(connectionId: string, model: string) { return JSON.stringify([connectionId, model]); }
function selectedModelValue(model: JobModel) { return model.modelConnectionId && model.model ? modelValue(model.modelConnectionId, model.model) : ''; }
function modelFromValue(value: string): Required<JobModel> {
  if (!value) return { modelConnectionId: null, model: null };
  try {
    const [modelConnectionId, model] = JSON.parse(value) as [string, string];
    return modelConnectionId && model ? { modelConnectionId, model } : { modelConnectionId: null, model: null };
  } catch { return { modelConnectionId: null, model: null }; }
}
function unavailableModelLabel(model: JobModel) {
  return model.modelConnectionId && model.model ? `Unavailable override · ${model.modelConnectionId} · ${model.model}` : '';
}

export function AgentSchedules({ agentId, savedProviders, overflowTarget }: { agentId: string; savedProviders: SavedProvider[]; overflowTarget?: HTMLElement | null }) {
  const resourceId = agentId.includes('::') ? agentId.slice(agentId.indexOf('::') + 2) : agentId;
  const request = <T,>(path: string, init?: RequestInit) => api<T>(path, init);
  const confirm = useConfirm();
  const modelOptions: ModelOption[] = savedProviders.flatMap((provider) => provider.models.map((model) => ({ value: modelValue(provider.id, model), label: `${provider.provider} · ${provider.modelLabels?.[model] ?? model}` })));
  const [jobs, setJobs] = useState<ScheduledJob[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [viewingManagedId, setViewingManagedId] = useState<string | null>(null);
  const [name, setName] = useState(''); const [prompt, setPrompt] = useState(''); const [cron, setCron] = useState('0 9 * * *'); const [timezone, setTimezone] = useState<string | null>(null); const [enabled, setEnabled] = useState(true);
  const [jobModel, setJobModel] = useState<JobModel>({ modelConnectionId: null, model: null });
  const [state, setState] = useState<'loading' | 'idle' | 'saving'>('loading'); const [error, setError] = useState('');
  const [triggeringId, setTriggeringId] = useState<string | null>(null); const [notice, setNotice] = useState('');
  const requestVersion = useRef(0);
  const [operatorTimezone, setOperatorTimezone] = useState('');
  const nameInput = useRef<HTMLInputElement>(null);
  const load = async (signal?: AbortSignal, version = requestVersion.current) => {
    try {
      const result = await request<{ jobs: ScheduledJob[] }>(`/api/scheduled-jobs?agentId=${encodeURIComponent(resourceId)}`, { signal });
      if (!signal?.aborted && version === requestVersion.current) setJobs(result.jobs ?? []);
    } catch (cause) {
      if (!signal?.aborted && version === requestVersion.current) setError(cause instanceof Error ? `Could not load schedules: ${cause.message}` : 'Could not load schedules.');
    } finally { if (!signal?.aborted && version === requestVersion.current) setState('idle'); }
  };
  useEffect(() => {
    const version = ++requestVersion.current;
    const controller = new AbortController();
    setState('loading'); setEditingId(null); setViewingManagedId(null); setError(''); setNotice(''); setTriggeringId(null); setJobModel({ modelConnectionId: null, model: null });
    setTimezone(null); setOperatorTimezone('');
    void request<{ timezone: string }>('/api/settings/timezone', { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted && version === requestVersion.current && result.timezone) { setOperatorTimezone(result.timezone); }
    }).catch(() => { if (!controller.signal.aborted) setError('Could not load default timezone; enter a timezone explicitly.'); });
    void load(controller.signal, version);
    return () => controller.abort();
  }, [agentId]);
  const reset = () => { setEditingId(null); setViewingManagedId(null); setName(''); setPrompt(''); setCron('0 9 * * *'); setTimezone(null); setEnabled(true); setJobModel({ modelConnectionId: null, model: null }); setError(''); };
  const edit = (job: ScheduledJob) => { setViewingManagedId(null); setEditingId(job.id); setName(job.name); setPrompt(job.prompt); setCron(job.cron); setTimezone(job.timezone); setEnabled(job.enabled); setJobModel({ modelConnectionId: job.modelConnectionId ?? null, model: job.model ?? null }); setError(''); nameInput.current?.focus(); };
  const viewManaged = (job: ScheduledJob) => { setEditingId(null); setViewingManagedId(job.id); setError(''); };
  useEffect(() => { if (viewingManagedId) nameInput.current?.focus(); }, [viewingManagedId]);
  const save = async () => {
    if (!name.trim() || !prompt.trim() || !cron.trim() || (timezone !== null && !timezone.trim())) { setError('Name, prompt, cron, and timezone are required.'); return; }
    setState('saving'); setError('');
    try {
      await request(editingId ? `/api/scheduled-jobs/${encodeURIComponent(editingId)}` : '/api/scheduled-jobs', { method: editingId ? 'PATCH' : 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...(editingId ? {} : { agentId: resourceId }), name: name.trim(), prompt: prompt.trim(), cron: cron.trim(), timezone: timezone === null ? null : timezone.trim(), enabled, modelConnectionId: jobModel.modelConnectionId ?? null, model: jobModel.model ?? null }) });
      await load(); reset();
    } catch (cause) { setError(cause instanceof Error ? `Could not save schedule: ${cause.message}` : 'Could not save schedule.'); setState('idle'); }
  };
  const runNow = async (job: ScheduledJob) => {
    setTriggeringId(job.id); setError(''); setNotice('');
    const version = requestVersion.current;
    try {
      const result = await request<{ ok: boolean; error?: string }>(`/api/scheduled-jobs/${encodeURIComponent(job.id)}/trigger`, jsonMutation('POST'));
      if (version !== requestVersion.current) return;
      if (!result.ok) { setError(`Could not run ${job.name}: ${result.error || 'The scheduler rejected the request.'}`); return; }
      setNotice(`${job.name} started. The run continues in the background.`);
    } catch (cause) {
      if (version === requestVersion.current) setError(cause instanceof Error ? `Could not run ${job.name}: ${cause.message}` : `Could not run ${job.name}.`);
    } finally { if (version === requestVersion.current) setTriggeringId(null); }
  };
  const remove = async (job: ScheduledJob) => { if (!await confirm({ title: 'Delete scheduled job?', message: job.ownerModId ? `Delete ${job.name}? This job is managed by ${job.ownerModId} and the mod may create it again.` : `Delete ${job.name}?`, confirmLabel: 'Delete job', tone: 'danger' })) return; try { await request(`/api/scheduled-jobs/${encodeURIComponent(job.id)}`, { method: 'DELETE' }); setJobs(items => items.filter(item => item.id !== job.id)); if (editingId === job.id || viewingManagedId === job.id) reset(); } catch (cause) { setError(cause instanceof Error ? `Could not delete schedule: ${cause.message}` : 'Could not delete schedule.'); } };
  const managedJob = jobs.find(job => job.id === viewingManagedId && job.ownerModId) ?? null;
  const inventory = state === 'loading' ? <p className="settings-empty">Loading cron jobs…</p> : jobs.length === 0 ? <p className="settings-empty">No cron jobs configured for this agent.</p> : <div className="schedule-list">{jobs.map(job => {
    const overrideValue = selectedModelValue(job);
    const override = modelOptions.find((option) => option.value === overrideValue);
    return <article className="schedule-card" key={job.id}><div className="schedule-card-details">{job.ownerModId ? <button className="schedule-card-select" type="button" onClick={() => viewManaged(job)} aria-pressed={viewingManagedId === job.id}><strong>{job.name}</strong><small>Managed by {job.ownerModId}</small><small>{job.cron} · {job.timezone === null ? `Operator timezone · ${job.effectiveTimezone || 'Loading…'}` : job.timezone}</small><small>{overrideValue ? (override?.label ?? unavailableModelLabel(job)) : 'Uses agent chat model'}</small></button> : <button className="schedule-card-select" type="button" onClick={() => edit(job)} aria-pressed={editingId === job.id}><strong>{job.name}</strong><small>{job.cron} · {job.timezone === null ? `Operator timezone · ${job.effectiveTimezone || 'Loading…'}` : job.timezone}</small><small>{overrideValue ? (override?.label ?? unavailableModelLabel(job)) : 'Uses agent chat model'}</small></button>}</div><div className="schedule-card-actions"><button className="secondary" type="button" onClick={() => void runNow(job)} disabled={triggeringId !== null}>{triggeringId === job.id ? "Starting…" : "Run now"}</button>{!job.ownerModId && <button className="danger" type="button" onClick={() => void remove(job)}>Delete</button>}</div></article>;
  })}</div>;
  const selectedValue = selectedModelValue(jobModel);
  const persistedOverrideUnavailable = Boolean(selectedValue && !modelOptions.some((option) => option.value === selectedValue));
  const editor = <><p className="settings-description">Run prompts for this agent on a five-field cron schedule. Jobs use the agent’s configured chat model unless you choose an override.</p><div className="schedule-form"><Field label="Name"><input ref={nameInput} value={name} onChange={event => setName(event.target.value)} placeholder="Morning briefing" /></Field><Field label="Prompt"><textarea value={prompt} onChange={event => setPrompt(event.target.value)} rows={3} placeholder="Prepare the daily briefing…" /></Field><Field label="Model"><select value={selectedValue} onChange={(event) => setJobModel(modelFromValue(event.target.value))}><option value="">Use agent chat model</option>{persistedOverrideUnavailable && <option value={selectedValue}>{unavailableModelLabel(jobModel)}</option>}{modelOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select><small className="field-hint">This changes only this cron job, not the agent’s configured model.</small></Field>{persistedOverrideUnavailable && <p className="settings-request-error" role="alert">This job’s model override is unavailable. Choose an available model or use the agent chat model before saving; it will not silently fall back.</p>}<div className="schedule-field-pair"><Field label="Cron"><input value={cron} onChange={event => setCron(event.target.value)} placeholder="0 9 * * *" /><small className="field-hint">minute hour day month weekday</small></Field><Field label="Timezone"><label><input type="checkbox" aria-label="Use operator timezone" checked={timezone === null} onChange={event => setTimezone(event.target.checked ? null : operatorTimezone)} />Use operator timezone</label>{timezone === null ? <small className="field-hint">Effective timezone: {jobs.find(job => job.id === editingId)?.effectiveTimezone || operatorTimezone || 'Loading…'}. Follows operator timezone changes.</small> : <input value={timezone} onChange={event => setTimezone(event.target.value)} placeholder="America/New_York" />}</Field></div><div className="schedule-footer"><label className="schedule-enabled"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} /><span>Enabled</span></label><div className="setting-actions"><button className="secondary" type="button" onClick={reset} disabled={state === 'saving'}>{editingId ? 'Cancel' : 'Clear'}</button><button className="primary" type="button" onClick={() => void save()} disabled={state !== 'idle' || persistedOverrideUnavailable}>{state === 'saving' ? 'Saving…' : editingId ? 'Save job' : 'Add job'}</button></div></div></div></>;
  const managedDetails = managedJob && <div className="schedule-form"><p className="settings-description">Managed by {managedJob.ownerModId}. Edit this job through its mod; you can run or delete it here. The mod may recreate a deleted job.</p><Field label="Name"><input ref={nameInput} value={managedJob.name} readOnly /></Field><Field label="Prompt"><textarea value={managedJob.prompt} rows={3} readOnly /></Field><Field label="Schedule"><input value={`${managedJob.cron} · ${managedJob.timezone === null ? `Operator timezone · ${managedJob.effectiveTimezone || 'Loading…'}` : managedJob.timezone}`} readOnly /></Field><Field label="Model"><input value={modelOptions.find(option => option.value === selectedModelValue(managedJob))?.label || unavailableModelLabel(managedJob) || 'Uses agent chat model'} readOnly /></Field><div className="setting-actions"><button className="secondary" type="button" onClick={reset}>Back to new job</button><button className="danger" type="button" onClick={() => void remove(managedJob)}>Delete job</button></div></div>;
  return <><SettingSection title="Cron jobs">{managedDetails ?? editor}{!overflowTarget && inventory}{notice && <p role="status">{notice}</p>}{error && <p className="settings-request-error" role="alert">{error}</p>}</SettingSection>{overflowTarget && createPortal(<div className="settings-overflow-content"><SettingSection title="Saved cron jobs">{inventory}{notice && <p role="status">{notice}</p>}{error && <p className="settings-request-error" role="alert">{error}</p>}</SettingSection></div>, overflowTarget)}</>;
}
