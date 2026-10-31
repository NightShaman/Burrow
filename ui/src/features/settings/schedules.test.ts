import { describe, expect, it } from 'vitest';
import {
  operatorDateTimeInput,
  scheduleDraft,
  schedulePayload,
  scheduleRunLabel,
  scheduleTime,
  taskEligibility,
  type ScheduledJob,
  type ScheduleDraft,
  type ScheduleTask,
} from './schedules';

const draft = (changes: Partial<ScheduleDraft> = {}): ScheduleDraft => ({
  name: '  Daily briefing  ',
  jobKind: 'prompt',
  prompt: '  Summarize today.  ',
  taskId: 'task-stale-from-another-mode',
  extraInstructions: '  stale task instructions  ',
  scheduleKind: 'cron',
  cron: '  5 4 * * *  ',
  runAt: '2026-07-15T08:05',
  enabled: false,
  modelConnectionId: 'connection-1',
  model: 'model-1',
  ...changes,
});

const task = (changes: Partial<ScheduleTask> = {}): ScheduleTask => ({
  id: 'task-1',
  projectId: 'project-1',
  title: 'Prepare briefing',
  status: 'todo',
  assignedAgentId: 'agent-1',
  ...changes,
});

describe('scheduleDraft', () => {
  it('provides prompt/cron defaults for blank and legacy schedule records', () => {
    expect(scheduleDraft()).toEqual({
      name: '',
      jobKind: 'prompt',
      prompt: '',
      taskId: '',
      extraInstructions: '',
      scheduleKind: 'cron',
      cron: '0 9 * * *',
      runAt: '',
      enabled: true,
      modelConnectionId: null,
      model: null,
    });

    const legacy: ScheduledJob = {
      id: 'job-legacy',
      agentId: 'agent-1',
      name: 'Legacy job',
      prompt: 'Keep the legacy prompt',
      cron: '15 6 * * 1-5',
      enabled: false,
    };
    expect(scheduleDraft(legacy)).toEqual({
      name: 'Legacy job',
      jobKind: 'prompt',
      prompt: 'Keep the legacy prompt',
      taskId: '',
      extraInstructions: '',
      scheduleKind: 'cron',
      cron: '15 6 * * 1-5',
      runAt: '',
      enabled: false,
      modelConnectionId: null,
      model: null,
    });
  });
});

describe('schedulePayload', () => {
  it('switches to a prompt-only payload without stale task state', () => {
    const payload = schedulePayload(draft());

    expect(payload).toEqual({
      name: 'Daily briefing',
      jobKind: 'prompt',
      prompt: 'Summarize today.',
      taskId: null,
      extraInstructions: '',
      scheduleKind: 'cron',
      cron: '5 4 * * *',
      runAt: null,
      enabled: false,
      modelConnectionId: 'connection-1',
      model: 'model-1',
    });
    expect(payload).not.toHaveProperty('sessionId');
    expect(payload).not.toHaveProperty('contextMode');
  });

  it('switches to the default continuing task context without copying task prose', () => {
    const payload = schedulePayload(draft({
      jobKind: 'task',
      prompt: 'Copied task title and description must never become schedule prose.',
      taskId: 'task-42',
      extraInstructions: '   ',
    }));

    expect(payload).toEqual({
      name: 'Daily briefing',
      jobKind: 'task',
      prompt: '',
      taskId: 'task-42',
      extraInstructions: '',
      sessionId: 'default',
      contextMode: 'continue',
      scheduleKind: 'cron',
      cron: '5 4 * * *',
      runAt: null,
      enabled: false,
      modelConnectionId: 'connection-1',
      model: 'model-1',
    });
    expect(payload).not.toHaveProperty('taskTitle');
    expect(payload).not.toHaveProperty('taskDescription');
  });

  it('keeps an untouched saved DST-offset instant but sends an edited datetime-local value as-is', () => {
    const savedRunAt = '2026-11-01T01:30:00-04:00';
    const savedOnceJob: ScheduledJob = {
      id: 'job-once',
      agentId: 'agent-1',
      name: 'DST appointment',
      jobKind: 'prompt',
      prompt: 'Run once',
      scheduleKind: 'once',
      cron: null,
      runAt: savedRunAt,
      enabled: true,
    };
    const untouched = scheduleDraft(savedOnceJob);

    expect(operatorDateTimeInput(untouched.runAt, 'America/New_York')).toBe('2026-11-01T01:30:00');
    expect(schedulePayload(untouched)).toMatchObject({
      scheduleKind: 'once',
      cron: null,
      runAt: savedRunAt,
    });

    const editedRunAt = '2026-11-01T01:30';
    const edited = { ...untouched, runAt: editedRunAt };
    expect(operatorDateTimeInput(edited.runAt, 'America/New_York')).toBe(editedRunAt);
    const editedPayload = schedulePayload(edited);
    expect(editedPayload).toMatchObject({
      scheduleKind: 'once',
      cron: null,
      runAt: editedRunAt,
    });
    expect(editedPayload).not.toHaveProperty('timezone');
  });
});

describe('taskEligibility', () => {
  it.each<[string, Partial<ScheduleTask>, string]>([
    ['an assigned ToDo task', {}, ''],
    ['a task assigned to another agent', { assignedAgentId: 'agent-2' }, 'Assigned to another agent'],
    ['an unassigned task', { assignedAgentId: null }, 'Unassigned'],
    ['a non-ToDo task assigned to this agent', { status: 'in_progress' }, 'In Progress'],
    ['an archived task before its assignee or status', { archived: true, assignedAgentId: 'agent-2', status: 'done' }, 'Archived'],
  ])('reports %s', (_label, changes, expected) => {
    expect(taskEligibility(task(changes), 'agent-1')).toBe(expected);
  });
});

describe('operator time formatting', () => {
  it('uses the supplied operator timezone rather than the browser zone, including DST', () => {
    const summerInstant = '2026-07-15T12:05:06Z';
    expect(operatorDateTimeInput(summerInstant, 'UTC')).toBe('2026-07-15T12:05:06');
    expect(operatorDateTimeInput(summerInstant, 'America/New_York')).toBe('2026-07-15T08:05:06');
    expect(operatorDateTimeInput('2026-01-15T12:05:06Z', 'America/New_York')).toBe('2026-01-15T07:05:06');
  });

  it('renders display timestamps in the supplied operator timezone', () => {
    const value = '2026-07-15T12:05:00Z';
    const options: Intl.DateTimeFormatOptions = {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    };
    expect(scheduleTime(value, 'America/New_York')).toBe(new Intl.DateTimeFormat(undefined, options).format(new Date(value)));
    expect(scheduleTime(value, 'UTC')).toBe(new Intl.DateTimeFormat(undefined, { ...options, timeZone: 'UTC' }).format(new Date(value)));
  });
});

describe('scheduleRunLabel', () => {
  it.each([
    ['running', 'Running'],
    ['completed', 'Completed'],
    ['succeeded', 'Completed'],
    ['failed', 'Failed'],
    ['cancelled', 'Cancelled'],
    ['missed', 'Missed'],
    ['skipped', 'Skipped'],
    ['scheduler-specific-status', 'scheduler-specific-status'],
  ])('labels %s last runs as %s', (status, label) => {
    expect(scheduleRunLabel(status)).toBe(label);
  });
});
