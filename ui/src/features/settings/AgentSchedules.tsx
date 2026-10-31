import { useUnsavedChanges, useUnsavedNavigation } from '../../app/UnsavedChanges';
import { ProviderModelFields } from './ProviderModelFields';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, jsonMutation } from '../../app/api';
import type { SavedProvider } from '../../app/types';
import { useConfirm } from '../../app/ConfirmDialog';
import { Field, SettingSection } from './SettingsPrimitives';
import {
  operatorDateTimeInput, scheduleDraft, schedulePayload, scheduleRunLabel, scheduleTime, taskEligibility,
  type JobModel, type ScheduleDraft, type ScheduledJob, type ScheduleProject, type ScheduleRun, type ScheduleTask,
} from './schedules';

type OpenChat = (sessionId: string, agentId: string) => void;
function modelValue(connectionId: string, model: string) { return JSON.stringify([connectionId, model]); }
function selectedModelValue(model: JobModel) { return model.modelConnectionId && model.model ? modelValue(model.modelConnectionId, model.model) : ''; }
function unavailableModelLabel(model: JobModel) {
  return model.modelConnectionId && model.model ? `Unavailable override · ${model.modelConnectionId} · ${model.model}` : '';
}

export function AgentSchedules({ agentId, savedProviders, overflowTarget, onOpenChat }: { agentId: string; savedProviders: SavedProvider[]; overflowTarget?: HTMLElement | null; onOpenChat?: OpenChat }) {
  const resourceId = agentId.includes('::') ? agentId.slice(agentId.indexOf('::') + 2) : agentId;
  const confirm = useConfirm();
  const navigate = useUnsavedNavigation();
  const modelOptions = savedProviders.flatMap(provider => provider.models.map(model => ({ value: modelValue(provider.id, model), label: `${provider.provider} · ${provider.modelLabels?.[model] ?? model}` })));
  const [jobs, setJobs] = useState<ScheduledJob[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [viewingManagedId, setViewingManagedId] = useState<string | null>(null);
  const [draft, setDraft] = useState(scheduleDraft);
  const [state, setState] = useState<'loading' | 'idle' | 'saving'>('loading');
  const [jobsLoaded, setJobsLoaded] = useState(false);
  const [error, setError] = useState('');
  const [triggeringId, setTriggeringId] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const requestVersion = useRef(0);
  const committed = useRef(false);
  const saving = useRef(false);
  const boardVersion = useRef(0);
  const jobsVersion = useRef(0);
  const [operatorTimezone, setOperatorTimezone] = useState('');
  const [timezoneError, setTimezoneError] = useState('');
  const [tasks, setTasks] = useState<ScheduleTask[]>([]);
  const [projects, setProjects] = useState<ScheduleProject[]>([]);
  const [boardState, setBoardState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [boardError, setBoardError] = useState('');
  const nameInput = useRef<HTMLInputElement>(null);
  const change = (patch: Partial<ScheduleDraft>) => setDraft(current => ({ ...current, ...patch }));

  const load = async (signal: AbortSignal | undefined, version: number): Promise<boolean> => {
    const jobsRequest = ++jobsVersion.current;
    try {
      const result = await api<{ jobs: ScheduledJob[] }>(`/api/scheduled-jobs?agentId=${encodeURIComponent(resourceId)}`, { signal });
      if (!signal?.aborted && version === requestVersion.current && jobsRequest === jobsVersion.current) { setJobs(result.jobs ?? []); setJobsLoaded(true); return true; }
    } catch (cause) {
      if (!signal?.aborted && version === requestVersion.current && jobsRequest === jobsVersion.current) { setJobsLoaded(false); setError(cause instanceof Error ? `Could not load schedules: ${cause.message}` : 'Could not load schedules.'); }
    }
    return false;
  };
  const loadTimezone = async (signal: AbortSignal | undefined, version: number) => {
    setTimezoneError('');
    try {
      const result = await api<{ timezone: string }>('/api/settings/timezone', { signal });
      if (!result.timezone) throw new Error('Timezone unavailable');
      new Intl.DateTimeFormat(undefined, { timeZone: result.timezone }).format();
      if (!signal?.aborted && version === requestVersion.current) setOperatorTimezone(result.timezone);
    } catch {
      if (!signal?.aborted && version === requestVersion.current) setTimezoneError('Could not load operator timezone.');
    }
  };
  const loadBoard = async (signal: AbortSignal | undefined, version: number) => {
    const boardRequest = ++boardVersion.current;
    setBoardState('loading'); setBoardError('');
    try {
      // Read saved records, not a copy of their descriptions. Fetch all statuses
      // so a previously selected Done/reassigned/archived task stays identifiable.
      const [taskResult, projectResult] = await Promise.all([
        api<{ tasks: ScheduleTask[] }>('/api/task-board/tasks', { signal }),
        api<{ projects: ScheduleProject[] }>('/api/task-board/projects', { signal }),
      ]);
      if (!Array.isArray(taskResult.tasks) || !Array.isArray(projectResult.projects)) throw new Error('Invalid task board response');
      if (!signal?.aborted && version === requestVersion.current && boardRequest === boardVersion.current) { setTasks(taskResult.tasks); setProjects(projectResult.projects); setBoardState('ready'); }
    } catch (cause) {
      if (!signal?.aborted && version === requestVersion.current && boardRequest === boardVersion.current) { setBoardState('error'); setBoardError(`Could not load task board: ${(cause as Error).message}`); }
    }
  };
  useEffect(() => {
    const version = ++requestVersion.current;
    const controller = new AbortController();
    committed.current = false; saving.current = false; ++boardVersion.current; setJobs([]); setDraft(scheduleDraft()); setState('loading'); setJobsLoaded(false);
    setEditingId(null); setViewingManagedId(null); setError(''); setNotice(''); setTriggeringId(null);
    setOperatorTimezone(''); setTasks([]); setProjects([]); setBoardState('idle'); setBoardError('');
    void loadTimezone(controller.signal, version);
    void load(controller.signal, version).finally(() => { if (!controller.signal.aborted && version === requestVersion.current) setState('idle'); });
    return () => { controller.abort(); ++requestVersion.current; };
  }, [agentId]);
  const needsBoard = draft.jobKind === 'task' || jobs.some(job => job.jobKind === 'task');
  useEffect(() => {
    if (!needsBoard) return;
    const controller = new AbortController();
    void loadBoard(controller.signal, requestVersion.current);
    return () => controller.abort();
  }, [agentId, needsBoard]);

  const reset = () => { committed.current = false; setEditingId(null); setViewingManagedId(null); setDraft(scheduleDraft()); setError(''); };
  const edit = (job: ScheduledJob) => { committed.current = false; setViewingManagedId(null); setEditingId(job.id); setDraft(scheduleDraft(job)); setError(''); nameInput.current?.focus(); };
  const viewManaged = (job: ScheduledJob) => { setEditingId(null); setViewingManagedId(job.id); setError(''); };
  useEffect(() => { if (viewingManagedId) nameInput.current?.focus(); }, [viewingManagedId]);
  const selectedJob = jobs.find(job => job.id === editingId);
  const selectedTask = tasks.find(task => task.id === draft.taskId);
  const retainingTask = Boolean(selectedJob?.jobKind === 'task' && selectedJob.taskId === draft.taskId);
  const taskProblem = boardState !== 'ready' ? '' : selectedTask ? taskEligibility(selectedTask, resourceId) : draft.taskId ? 'Task no longer exists' : '';
  const eligibleTasks = tasks.filter(task => !taskEligibility(task, resourceId));
  const taskGroups = [...new Set(eligibleTasks.map(task => task.projectId))].map(id => ({ id, name: projects.find(project => project.id === id)?.name ?? 'Unknown project' }));
  const taskLabel = (task: ScheduleTask) => `${projects.find(project => project.id === task.projectId)?.name ?? 'Unknown project'} · ${task.title}`;
  const selectedValue = selectedModelValue(draft);
  const persistedOverrideUnavailable = Boolean((draft.modelConnectionId || draft.model) && (!selectedValue || !modelOptions.some(option => option.value === selectedValue)));
  const save = async () => {
    if (state !== 'idle' || saving.current || !jobsLoaded || committed.current || triggeringId || persistedOverrideUnavailable) return false;
    if (!draft.name.trim()) { setError('Name is required.'); return false; }
    if (draft.jobKind === 'prompt' && !draft.prompt.trim()) { setError('Prompt is required.'); return false; }
    if (draft.jobKind === 'task' && (!draft.taskId || (!retainingTask && (boardState !== 'ready' || !selectedTask || taskProblem)))) { setError('Choose a saved ToDo task assigned to this agent.'); return false; }
    if (draft.scheduleKind === 'cron' && !draft.cron.trim()) { setError('Cron is required.'); return false; }
    if (draft.scheduleKind === 'once' && (!draft.runAt || !operatorTimezone)) { setError('Run at and the operator timezone are required.'); return false; }
    const version = requestVersion.current;
    saving.current = true;
    setState('saving'); setError(''); setNotice('');
    try {
      await api(editingId ? `/api/scheduled-jobs/${encodeURIComponent(editingId)}` : '/api/scheduled-jobs', jsonMutation(editingId ? 'PATCH' : 'POST', { ...(editingId ? {} : { agentId: resourceId }), ...schedulePayload(draft) }));
      if (version !== requestVersion.current) return false;
      committed.current = true;
      if (!await load(undefined, version)) { if (version === requestVersion.current) setError('Schedule saved, but refreshing jobs failed. Reload jobs before another save.'); return false; }
      if (version === requestVersion.current) { reset(); return true; }
    } catch (cause) {
      if (version !== requestVersion.current) return false;
      setError(cause instanceof Error ? `Could not save schedule: ${cause.message}` : 'Could not save schedule.'); setState('idle');
    } finally { if (version === requestVersion.current) { saving.current = false; setState('idle'); } }
    return false;
  };
  useUnsavedChanges({ dirty: !committed.current && state !== 'loading' && !viewingManagedId && JSON.stringify(draft) !== JSON.stringify(scheduleDraft(selectedJob)), busy: state === 'saving', save, discard: () => { if (selectedJob) edit(selectedJob); else reset(); } });
  const refresh = async () => {
    if (state !== 'idle' || triggeringId) return;
    const version = requestVersion.current;
    setError('');
    if (await load(undefined, version) && version === requestVersion.current && committed.current) reset();
    if (needsBoard && version === requestVersion.current) void loadBoard(undefined, version);
  };
  const runNow = async (job: ScheduledJob) => {
    if (triggeringId || state !== 'idle') return;
    setTriggeringId(job.id); setError(''); setNotice('');
    const version = requestVersion.current;
    try {
      const result = await api<{ ok: boolean; skipped?: boolean; error?: string; reason?: string; run?: ScheduleRun }>(`/api/scheduled-jobs/${encodeURIComponent(job.id)}/trigger`, jsonMutation('POST'));
      if (version !== requestVersion.current) return;
      if (result.skipped || result.run?.status === 'skipped') {
        const reason = result.reason || result.run?.error || result.error;
        setNotice(`${job.name} skipped.${reason ? ` ${reason}` : ''}`);
      } else if (!result.ok) { setError(`Could not run ${job.name}: ${result.error || 'The scheduler rejected the request.'}`); return; }
      else setNotice(`${job.name} started. The run continues in the background.`);
      await load(undefined, version);
    } catch (cause) {
      if (version === requestVersion.current) setError(cause instanceof Error ? `Could not run ${job.name}: ${cause.message}` : `Could not run ${job.name}.`);
    } finally { if (version === requestVersion.current) setTriggeringId(null); }
  };
  const remove = async (job: ScheduledJob) => {
    const version = requestVersion.current;
    if (!await confirm({ title: 'Delete scheduled job?', message: job.ownerModId ? `Delete ${job.name}? This job is managed by ${job.ownerModId} and the mod may create it again.` : `Delete ${job.name}?`, confirmLabel: 'Delete job', tone: 'danger' }) || version !== requestVersion.current) return;
    try {
      await api(`/api/scheduled-jobs/${encodeURIComponent(job.id)}`, { method: 'DELETE' });
      if (version !== requestVersion.current) return;
      setJobs(items => items.filter(item => item.id !== job.id)); if (editingId === job.id || viewingManagedId === job.id) reset();
    } catch (cause) { if (version === requestVersion.current) setError(cause instanceof Error ? `Could not delete schedule: ${cause.message}` : 'Could not delete schedule.'); }
  };
  const zoneFor = (job: ScheduledJob) => job.effectiveTimezone || operatorTimezone;
  const scheduleLabel = (job: ScheduledJob) => job.scheduleKind === 'once' ? `Once · ${scheduleTime(job.runAt, zoneFor(job))}` : `Recurring · ${job.cron}`;
  const managedJob = jobs.find(job => job.id === viewingManagedId && job.ownerModId) ?? null;
  const inventory = <>
    <div className="schedule-list-toolbar"><button className="secondary" type="button" disabled={state !== 'idle' || triggeringId !== null} onClick={() => void refresh()}>Refresh jobs</button></div>
    {state === 'loading' ? <p className="settings-empty">Loading schedules…</p> : !jobsLoaded ? <p className="settings-empty">Schedules unavailable. Refresh jobs to retry.</p> : jobs.length === 0 ? <p className="settings-empty">No scheduled jobs for this agent.</p> : <div className="schedule-list">{jobs.map(job => {
      const overrideValue = selectedModelValue(job);
      const last = job.lastRun;
      const task = tasks.find(item => item.id === job.taskId);
      const selected = job.id === (editingId ?? viewingManagedId);
      return <article className={`schedule-card${selected ? ' is-selected' : ''}`} key={job.id}>
        <div className="schedule-card-details">
          <button className="schedule-card-select" type="button" disabled={state === 'saving'} onClick={() => { if (!selected) navigate(() => job.ownerModId ? viewManaged(job) : edit(job)); }} aria-pressed={selected}>
            <strong>{job.name}</strong>
            {job.ownerModId && <small>Managed by {job.ownerModId}</small>}
            <small>{job.jobKind === 'task' ? 'Board task' : 'Prompt'} · {job.enabled ? 'Enabled' : 'Paused'}</small>
            <small>{scheduleLabel(job)} · {zoneFor(job) || 'Operator timezone unavailable'}</small>
            {job.jobKind === 'task' && boardState === 'ready' && <small>{task ? taskLabel(task) : 'Task no longer exists'}</small>}
            {job.enabled && <small>Next · {scheduleTime(job.nextRunAt, zoneFor(job))}</small>}
            {overrideValue && <small>{modelOptions.find(option => option.value === overrideValue)?.label ?? unavailableModelLabel(job)}</small>}
          </button>
          <div className="schedule-last-run">
            <small>Last · {last ? scheduleRunLabel(last.status) : job.lastRunAt ? 'Recorded run' : 'Not run'}{(last?.completedAt || job.lastRunAt) ? ` · ${scheduleTime(last?.completedAt || job.lastRunAt, zoneFor(job))}` : ''}</small>
            {last?.error && <small className={last.status === 'failed' ? 'schedule-result-error' : ''}>{last.error}</small>}
            {onOpenChat && last?.sessionId && last.runId && !['skipped', 'missed'].includes(last.status) && <button className="schedule-chat-link" type="button" onClick={() => navigate(() => onOpenChat(last.sessionId!, last.agentId || job.agentId))}>Open chat<span className="sr-only"> for {job.name}</span></button>}
          </div>
        </div>
        <div className="schedule-card-actions"><button className="secondary" type="button" onClick={() => void runNow(job)} disabled={triggeringId !== null || state !== 'idle'}>{triggeringId === job.id ? 'Starting…' : 'Run now'}</button>{!job.ownerModId && <button className="danger" type="button" disabled={state === 'saving'} onClick={() => { if (selected) navigate(() => void remove(job)); else void remove(job); }}>Delete</button>}</div>
      </article>;
    })}</div>}
  </>;
  const editor = <div className="schedule-form"><fieldset className="schedule-fields" disabled={state !== 'idle' || !jobsLoaded || committed.current}>
    <div className="schedule-field-pair">
      <Field label="Run"><select value={draft.jobKind} onChange={event => change({ jobKind: event.target.value as ScheduleDraft['jobKind'] })}><option value="prompt">Prompt</option><option value="task">Board task</option></select></Field>
      <Field label="Schedule"><select value={draft.scheduleKind} onChange={event => change({ scheduleKind: event.target.value as ScheduleDraft['scheduleKind'] })}><option value="cron">Recurring</option><option value="once">Once</option></select></Field>
    </div>
    {draft.jobKind === 'task' && <div>
      <Field label="Task"><select aria-label="Task" value={draft.taskId} disabled={boardState !== 'ready'} onChange={event => {
        const task = tasks.find(item => item.id === event.target.value);
        change({ taskId: event.target.value, ...(!draft.name.trim() || draft.name === selectedTask?.title ? { name: task?.title ?? '' } : {}) });
      }}><option value="">{boardState === 'loading' || boardState === 'idle' ? 'Loading tasks…' : eligibleTasks.length ? 'Choose a ToDo task' : 'No ToDo tasks assigned to this agent'}</option>
        {draft.taskId && !eligibleTasks.some(task => task.id === draft.taskId) && <option value={draft.taskId} disabled>{selectedTask ? taskLabel(selectedTask) : `Saved task · ${draft.taskId}`}{taskProblem ? ` · ${taskProblem} (will skip)` : ''}</option>}
        {taskGroups.map(project => <optgroup key={project.id} label={project.name}>{eligibleTasks.filter(task => task.projectId === project.id).map(task => <option key={task.id} value={task.id}>{task.title}</option>)}</optgroup>)}
      </select></Field>
      {taskProblem ? <p className="schedule-task-warning" role="status">{taskProblem}. This job will skip unless the saved task is unarchived, assigned to this agent, and ToDo when it runs.</p> : <small className="field-hint">Only this agent’s saved ToDo tasks can start. Eligibility is checked again when the job runs.</small>}
      {boardError && <p className="settings-request-error" role="alert">{boardError} <button className="secondary" type="button" onClick={() => void loadBoard(undefined, requestVersion.current)}>Retry tasks</button></p>}
    </div>}
    <Field label="Name"><input ref={nameInput} value={draft.name} onChange={event => change({ name: event.target.value })} placeholder={draft.jobKind === 'task' ? 'Task title' : 'Morning briefing'} /></Field>
    {draft.jobKind === 'prompt' ? <Field label="Prompt"><textarea value={draft.prompt} onChange={event => change({ prompt: event.target.value })} rows={3} placeholder="Prepare the daily briefing…" /></Field> : <Field label="Extra instructions (optional)"><textarea value={draft.extraInstructions} onChange={event => change({ extraInstructions: event.target.value })} rows={2} placeholder="Any additional direction for this run…" /></Field>}
    {draft.scheduleKind === 'cron' ? <Field label="Cron"><input aria-label="Cron" value={draft.cron} onChange={event => change({ cron: event.target.value })} placeholder="0 9 * * *" /></Field> : <Field label="Run at"><input aria-label="Run at" type="datetime-local" step="1" disabled={!operatorTimezone} value={operatorDateTimeInput(draft.runAt, operatorTimezone)} onChange={event => change({ runAt: event.target.value })} /></Field>}
    <small className="field-hint schedule-timezone">{draft.scheduleKind === 'cron' && 'minute hour day month weekday. '}Operator timezone · {operatorTimezone || (timezoneError ? 'Unavailable' : 'Loading…')}</small>
    {timezoneError && <p className="settings-request-error" role="alert">{timezoneError} <button className="secondary" type="button" onClick={() => void loadTimezone(undefined, requestVersion.current)}>Retry timezone</button></p>}
    <ProviderModelFields providers={savedProviders} connectionId={draft.modelConnectionId} model={draft.model} inheritLabel="Use agent chat model" onChange={(modelConnectionId, model) => change({ modelConnectionId, model })} />
    {persistedOverrideUnavailable && <p className="settings-request-error" role="alert">This job’s model override is unavailable. Choose an available model or use the agent chat model before saving; it will not silently fall back.</p>}
    <div className="schedule-footer"><label className="schedule-enabled"><input type="checkbox" checked={draft.enabled} onChange={event => change({ enabled: event.target.checked })} /><span>Enabled</span></label><div className="setting-actions"><button className="secondary" type="button" onClick={() => navigate(reset)}>{editingId ? 'Cancel' : 'Clear'}</button><button className="primary" type="button" onClick={() => void save()} disabled={persistedOverrideUnavailable || triggeringId !== null || (draft.scheduleKind === 'once' && !operatorTimezone) || (draft.jobKind === 'task' && !retainingTask && boardState !== 'ready')}>{state === 'saving' ? 'Saving…' : editingId ? 'Save job' : 'Add job'}</button></div></div>
  </fieldset></div>;
  const managedDetails = managedJob && <div className="schedule-form">
    <p className="settings-description">Managed by {managedJob.ownerModId}. Edit this job through its mod; you can run or delete it here. The mod may recreate a deleted job.</p>
    <Field label="Name"><input ref={nameInput} value={managedJob.name} readOnly /></Field>
    {managedJob.jobKind === 'task' ? <><Field label="Task"><input value={tasks.find(task => task.id === managedJob.taskId)?.title ?? managedJob.taskId ?? 'Task unavailable'} readOnly /></Field><Field label="Extra instructions (optional)"><textarea value={managedJob.extraInstructions ?? ''} rows={2} readOnly /></Field></> : <Field label="Prompt"><textarea value={managedJob.prompt} rows={3} readOnly /></Field>}
    <Field label="Schedule"><input value={`${scheduleLabel(managedJob)} · ${zoneFor(managedJob) || 'Operator timezone unavailable'}`} readOnly /></Field>
    <Field label="Model"><input value={modelOptions.find(option => option.value === selectedModelValue(managedJob))?.label || unavailableModelLabel(managedJob) || 'Uses agent chat model'} readOnly /></Field>
    <div className="setting-actions"><button className="secondary" type="button" onClick={() => navigate(reset)}>Back to new job</button><button className="danger" type="button" onClick={() => void remove(managedJob)}>Delete job</button></div>
  </div>;
  return <><SettingSection title="Cron jobs">{managedDetails ?? editor}{!overflowTarget && inventory}{!overflowTarget && notice && <p role="status">{notice}</p>}{error && <p className="settings-request-error" role="alert">{error}</p>}</SettingSection>{overflowTarget && createPortal(<div className="settings-overflow-content"><SettingSection title="Saved jobs">{inventory}{notice && <p role="status">{notice}</p>}</SettingSection></div>, overflowTarget)}</>;
}
