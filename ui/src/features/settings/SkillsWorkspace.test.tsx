import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ConfirmProvider } from '../../app/ConfirmDialog';
import { api } from '../../app/api';
import type { Agent } from '../../app/types';
import { SkillsSettings } from './SkillsSettings';
vi.mock('../../app/api', async (original) => ({
  ...(await original<typeof import('../../app/api')>()),
  api: vi.fn(),
}));
const agents = Array.from({ length: 17 }, (_, i) => ({
  id: `agent-${i}`,
  name: `Agent ${i}`,
})) as Agent[];
const skill = {
  id: 'review',
  name: 'Review',
  description: 'Review changes',
  content: '# Review',
  lifecycle: 'available',
  global: false,
  source: 'sqlite',
  version: 'one',
};
afterEach(() => {
  cleanup();
  vi.mocked(api).mockReset();
});
it('keeps all 17 assignments and optional source controls alongside the selected editor', async () => {
  vi.mocked(api).mockImplementation(
    async (path, init) =>
      (init?.method
        ? {}
        : path === '/api/settings/skills'
          ? { skills: [skill] }
          : path.endsWith('/source')
            ? { source: null }
            : { assignedSkillIds: [], globalSkillIds: [] }) as never,
  );
  const { container } = render(
    <ConfirmProvider>
      <SkillsSettings section="installed" agents={agents} agentId="agent-0" />
    </ConfirmProvider>,
  );
  fireEvent.click(await screen.findByRole('button', { name: /^Review/ }));
  expect(screen.getByLabelText('Content')).toHaveProperty('value', '# Review');
  const grid = container.querySelector('.skills-assignment-grid') as HTMLElement;
  expect(within(grid).getAllByRole('checkbox')).toHaveLength(17);
  fireEvent.click(within(grid).getByRole('checkbox', { name: 'Agent 16' }));
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith(
      '/api/agents/agent-16/skills',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ skillIds: ['review'] }) }),
    ),
  );
  const disclosure = container.querySelector('.skills-source-group') as HTMLDetailsElement;
  expect(disclosure.open).toBe(false);
  // The optional form remains mounted while collapsed, so its draft guards survive.
  expect(disclosure.querySelector('input')).not.toBeNull();
  disclosure.open = true;
  expect(screen.getByLabelText('Repository')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Save skill' })).toBeTruthy();
});
it('keeps global assignments disabled and local assignments selectable in the agent grid', async () => {
  vi.mocked(api).mockImplementation(
    async (path) =>
      (path === '/api/settings/skills'
        ? { skills: [skill, { ...skill, id: 'global', name: 'Global skill', global: true }] }
        : { assignedSkillIds: [], globalSkillIds: ['global'] }) as never,
  );
  render(
    <ConfirmProvider>
      <SkillsSettings agentView agents={agents} agentId="agent-0" />
    </ConfirmProvider>,
  );
  expect(await screen.findByRole('checkbox', { name: 'Review' })).toHaveProperty('disabled', false);
  expect(screen.getByRole('checkbox', { name: /Global skill/ })).toHaveProperty('disabled', true);
});
