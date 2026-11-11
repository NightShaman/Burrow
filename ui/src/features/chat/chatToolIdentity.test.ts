import { expect, it } from 'vitest';
import { chatToolIdentity } from './chatToolIdentity';

it('uses only the explicit mod tool identity and preserves its exact spelling', () => {
  expect(
    chatToolIdentity({ tool: 'mod_agent_tool', modToolName: '  resident_notebook.read  ' }),
  ).toEqual({ label: 'resident_notebook.read' });
});
it.each([undefined, null, '', '  ', 42, {}, ['forged']])(
  'uses a safe mod fallback for missing or invalid identity %j',
  (modToolName) => {
    const data = {
      tool: 'mod_agent_tool',
      modToolName,
      name: 'payload-name',
      label: 'payload-label',
      detail: 'private',
      arguments: { name: 'payload-tool' },
      output: 'private-output',
    };
    expect(chatToolIdentity(data)).toEqual({ label: 'Mod tool' });
  },
);
it('does not reinterpret ordinary tool labels from mod metadata', () => {
  expect(chatToolIdentity({ tool: 'shell_exec', modToolName: 'notebook' })).toBeUndefined();
});
