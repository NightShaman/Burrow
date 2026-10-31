export type JobKind = 'prompt' | 'task';
export type ScheduleKind = 'cron' | 'once';
export type JobModel = { modelConnectionId?: string | null; model?: string | null };
export type ScheduleRun = {
  status: string;
  error?: string | null;
  completedAt?: string | null;
  sessionId?: string | null;
  agentId?: string | null;
  runId?: string | null;
};
export type ScheduledJob = JobModel & {
  id: string;
  ownerModId?: string | null;
  agentId: string;
  name: string;
  jobKind?: JobKind;
  prompt: string;
  taskId?: string | null;
  extraInstructions?: string;
  scheduleKind?: ScheduleKind;
  cron: string | null;
  runAt?: string | null;
  timezone?: string | null;
  effectiveTimezone?: string;
  sessionId?: string;
  contextMode?: 'continue' | 'fresh';
  enabled: boolean;
  nextRunAt?: string | null;
  lastRunAt?: string | null;
  lastRun?: ScheduleRun | null;
};
export type ScheduleTask = {
  id: string;
  projectId: string;
  title: string;
  status: string;
  assignedAgentId: string | null;
  archived?: boolean;
};
export type ScheduleProject = { id: string; name: string };
export type ScheduleDraft = {
  name: string;
  jobKind: JobKind;
  prompt: string;
  taskId: string;
  extraInstructions: string;
  scheduleKind: ScheduleKind;
  cron: string;
  runAt: string;
  enabled: boolean;
  modelConnectionId: string | null;
  model: string | null;
};

export function scheduleDraft(job?: ScheduledJob): ScheduleDraft {
  return {
    name: job?.name ?? '', jobKind: job?.jobKind ?? 'prompt', prompt: job?.prompt ?? '',
    taskId: job?.taskId ?? '', extraInstructions: job?.extraInstructions ?? '',
    scheduleKind: job?.scheduleKind ?? 'cron', cron: job?.cron ?? '0 9 * * *', runAt: job?.runAt ?? '',
    enabled: job?.enabled ?? true, modelConnectionId: job?.modelConnectionId ?? null, model: job?.model ?? null,
  };
}

/** Never snapshot task prose, inherit a browser timezone, or dispatch from a save. */
export function schedulePayload(draft: ScheduleDraft) {
  return {
    name: draft.name.trim(), jobKind: draft.jobKind,
    prompt: draft.jobKind === 'prompt' ? draft.prompt.trim() : '',
    taskId: draft.jobKind === 'task' ? draft.taskId : null,
    extraInstructions: draft.jobKind === 'task' ? draft.extraInstructions.trim() : '',
    ...(draft.jobKind === 'task' ? { sessionId: 'default', contextMode: 'continue' } : {}),
    scheduleKind: draft.scheduleKind,
    cron: draft.scheduleKind === 'cron' ? draft.cron.trim() : null,
    // An untouched saved ISO instant stays intact, including its DST offset.
    // Edited datetime-local values are interpreted by the server in operator time.
    runAt: draft.scheduleKind === 'once' ? draft.runAt : null,
    enabled: draft.enabled, modelConnectionId: draft.modelConnectionId, model: draft.model,
  };
}

export function taskEligibility(task: ScheduleTask, agentId: string): string {
  if (task.archived) return 'Archived';
  if (task.assignedAgentId !== agentId) return task.assignedAgentId ? 'Assigned to another agent' : 'Unassigned';
  return task.status === 'todo' ? '' : task.status.replaceAll('_', ' ').replace(/\b\w/g, letter => letter.toUpperCase());
}

const hasOffset = (value: string) => /(?:Z|[+-]\d{2}:\d{2})$/i.test(value);
export function operatorDateTimeInput(value: string, timezone: string): string {
  if (!value || !hasOffset(value)) return value;
  if (!timezone) return '';
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', numberingSystem: 'latn',
    }).formatToParts(new Date(value));
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)?.value;
    return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}`;
  } catch { return ''; }
}

export function scheduleTime(value: string | null | undefined, timezone: string): string {
  if (!value) return '—';
  if (!timezone) return 'Timezone unavailable';
  try {
    return new Intl.DateTimeFormat(undefined, { timeZone: timezone, year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value));
  } catch { return 'Invalid date'; }
}

export function scheduleRunLabel(status: string) {
  return ({ running: 'Running', completed: 'Completed', succeeded: 'Completed', failed: 'Failed', cancelled: 'Cancelled', missed: 'Missed', skipped: 'Skipped' } as Record<string, string>)[status] ?? status;
}
