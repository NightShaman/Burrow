import { describe, expect, it } from 'vitest';
import { minionOutcome } from './minionOutcome';
describe('recorded minion outcomes', () => {
  it('distinguishes incomplete from execution errors and preserves recorded reason', () => {
    expect(minionOutcome('ERROR', { blockers: ['subagent_incomplete'], summary: 'Could not finish audit' })).toEqual({ label: 'Incomplete', reason: 'Could not finish audit · subagent_incomplete' });
  });
  it.each(['subagent_model_failed:offline', 'subagent_dispatch_failed:offline', 'subagent_timed_out', 'subagent_spawn_failed', 'subagent_child_failed:offline', 'subagent_invalid_json:bad', 'subagent_child_dispatch_failed:offline'])('keeps %s an Error', blocker => {
    expect(minionOutcome('failed', { blockers: ['subagent_incomplete', blocker] }).label).toBe('Error');
  });
  it('does not infer incomplete from prose or blocker counts', () => {
    expect(minionOutcome('ERROR', { summary: 'incomplete', blockers: 1 }).label).toBeUndefined();
    expect(minionOutcome('succeeded', { ok: true }).label).toBeUndefined();
  });
});

it('prefers structured blocker reasons over legacy arrays and counts', () => {
  expect(minionOutcome('failed', { blockers: 2, blockerReasons: ['needs_review'], outcome: 'incomplete' })).toEqual({ label: 'Incomplete', reason: 'needs_review' });
  expect(minionOutcome('failed', { blockers: ['subagent_incomplete'], blockerReasons: [], outcome: null }).label).toBeUndefined();
  expect(minionOutcome('failed', { blockerReasons: ['subagent_incomplete:prose'] }).label).toBeUndefined();
  expect(minionOutcome('timed_out', { outcome: 'incomplete' }).label).toBe('Error');
  expect(minionOutcome('failed', { outcome: 'incomplete', blockerReasons: ['subagent_model_failed:offline'] }).label).toBe('Error');
});
