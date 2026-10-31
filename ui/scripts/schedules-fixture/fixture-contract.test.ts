import { describe, expect, it } from 'vitest';
import { normalizeRunAt, taskSelectionProblem } from './contract';

describe('actual schedules fixture contract', () => {
  it('normalizes operator Chicago time, not browser time, and preserves saved offsets', () => {
    expect(normalizeRunAt('2030-06-12T08:45')).toBe('2030-06-12T13:45:00.000Z');
    expect(normalizeRunAt('2026-11-01T01:30:00-06:00')).toBe('2026-11-01T01:30:00-06:00');
  });
  it('handles winter, chooses earlier fall-back instant and rejects a nonexistent spring-forward wall time', () => {
    expect(normalizeRunAt('2030-01-12T08:45')).toBe('2030-01-12T14:45:00.000Z');
    expect(normalizeRunAt('2026-11-01T01:30')).toBe('2026-11-01T06:30:00.000Z');
    expect(() => normalizeRunAt('2026-03-08T02:30')).toThrow('not a valid America/Chicago local time');
  });
  it('only admits eligible new task selections', () => {
    const selection = { jobKind: 'task' as const, taskId: 'saved' };
    const task = { id: 'saved', status: 'todo', assignedAgentId: 'smatchet' };
    expect(taskSelectionProblem(selection, undefined, [task], 'smatchet')).toBe('');
    expect(taskSelectionProblem(selection, undefined, [{ ...task, status: 'done' }], 'smatchet')).toBe('Task is not in To Do');
    expect(taskSelectionProblem(selection, undefined, [{ ...task, archived: true }], 'smatchet')).toBe('Task is archived');
    expect(taskSelectionProblem(selection, undefined, [{ ...task, assignedAgentId: 'hatchet' }], 'smatchet')).toBe('Task is assigned to another agent');
  });
  it('retains an unchanged stale or missing task on PATCH, but not on a new selection', () => {
    const selection = { jobKind: 'task' as const, taskId: 'saved' };
    expect(taskSelectionProblem(selection, selection, [], 'smatchet')).toBe('');
    expect(taskSelectionProblem(selection, selection, [{ id: 'saved', status: 'done', assignedAgentId: null, archived: true }], 'smatchet')).toBe('');
    expect(taskSelectionProblem(selection, undefined, [], 'smatchet')).toBe('Task no longer exists');
  });
});
