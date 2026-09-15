import { expect, it } from 'vitest';
import { toolDisplayName } from './toolDisplayName';

it('maps the internal spawn_subagent identifier to its operator-facing Minion label', () => {
  expect(toolDisplayName('spawn_subagent')).toBe('Spawn Minion');
  expect(toolDisplayName('spawn-subagent')).toBe('Spawn Minion');
});

it('leaves unrelated tool identifiers untouched', () => {
  expect(toolDisplayName('shell_exec')).toBe('shell_exec');
});
