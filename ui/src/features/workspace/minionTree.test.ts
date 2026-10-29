import { describe, expect, it } from 'vitest';
import type { Subagent } from '../../app/types';
import { minionTree } from './minionTree';

const child = (id: string, patch: Partial<Subagent> = {}): Subagent => ({ id, name: id, avatar: '↳', activity: 'Working', context: null, stream: id, ...patch });

describe('minionTree presentation', () => {
  it('groups out-of-order descendants by session without mutating the flat registry', () => {
    const minions = [child('grandchild', { parentSessionId: 'child' }), child('sibling', { parentSessionId: 'root' }), child('child', { parentSessionId: 'root' })];
    const tree = minionTree(minions);
    expect(tree.map(node => node.minion.id)).toEqual(['sibling', 'child']);
    expect(tree[1].children.map(node => node.minion.id)).toEqual(['grandchild']);
    expect(minions.map(node => node.id)).toEqual(['grandchild', 'sibling', 'child']);
    expect(minions[2]).not.toHaveProperty('children');
  });

  it('resolves resource session ids and falls back to parent run ids', () => {
    const tree = minionTree([child('qualified-child', { resourceId: 'session', runId: 'run' }), child('session-descendant', { parentSessionId: 'session' }), child('run-descendant', { parentRunId: 'run' })]);
    expect(tree).toHaveLength(1);
    expect(tree[0].children.map(node => node.minion.id)).toEqual(['session-descendant', 'run-descendant']);
  });

  it('uses the parent run when another run shares its session', () => {
    const tree = minionTree([
      child('parent-run', { resourceId: 'shared-session', runId: 'expected-run' }),
      child('other-run', { resourceId: 'shared-session', runId: 'other-run' }),
      child('descendant', { parentSessionId: 'shared-session', parentRunId: 'expected-run' }),
    ]);
    expect(tree.map(node => node.minion.id)).toEqual(['parent-run', 'other-run']);
    expect(tree[0].children.map(node => node.minion.id)).toEqual(['descendant']);
    expect(tree[1].children).toEqual([]);
  });

  it('matches both parent ids when a run id is reused across sessions', () => {
    const tree = minionTree([
      child('expected-parent', { resourceId: 'expected-session', runId: 'reused-run' }),
      child('other-parent', { resourceId: 'other-session', runId: 'reused-run' }),
      child('descendant', { parentSessionId: 'expected-session', parentRunId: 'reused-run' }),
    ]);
    expect(tree.map(node => node.minion.id)).toEqual(['expected-parent', 'other-parent']);
    expect(tree[0].children.map(node => node.minion.id)).toEqual(['descendant']);
    expect(tree[1].children).toEqual([]);
  });

  it('keeps conflicting parent ids visible as an orphan without either fallback', () => {
    const tree = minionTree([
      child('session-match', { resourceId: 'expected-session', runId: 'other-run' }),
      child('run-match', { resourceId: 'other-session', runId: 'expected-run' }),
      child('descendant', { parentSessionId: 'expected-session', parentRunId: 'expected-run' }),
    ]);
    expect(tree.map(node => node.minion.id)).toEqual(['session-match', 'run-match', 'descendant']);
    expect(tree.every(node => node.children.length === 0)).toBe(true);
  });

  it('keeps a missing parent run visible as an orphan despite a matching session', () => {
    const tree = minionTree([
      child('other-run', { resourceId: 'shared-session', runId: 'other-run' }),
      child('descendant', { parentSessionId: 'shared-session', parentRunId: 'retained-away-run' }),
    ]);
    expect(tree.map(node => node.minion.id)).toEqual(['other-run', 'descendant']);
    expect(tree.every(node => node.children.length === 0)).toBe(true);
  });

  it('keeps missing ancestry and legacy flat nodes visible without inferring parents from depth', () => {
    const tree = minionTree([child('orphan', { parentSessionId: 'missing', depth: 2 }), child('legacy'), child('root-child', { parentSessionId: 'root', depth: 1 })]);
    expect(tree.map(node => node.minion.id)).toEqual(['orphan', 'legacy', 'root-child']);
    expect(tree.every(node => node.children.length === 0)).toBe(true);
  });

  it('terminates cycles and emits each session only once', () => {
    const tree = minionTree([child('a', { parentSessionId: 'b' }), child('b', { parentSessionId: 'a' }), child('self', { parentSessionId: 'self' }), child('a'), child('below-cycle', { parentSessionId: 'a' })]);
    expect(tree.map(node => node.minion.id)).toEqual(['a', 'b', 'self', 'below-cycle']);
    expect(tree.every(node => node.children.length === 0)).toBe(true);
  });
});
