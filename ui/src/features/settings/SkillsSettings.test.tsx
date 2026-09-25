import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiForTarget } from '../../app/api';
import type { Agent } from '../../app/types';
import type { ApiTarget } from '../../app/apiTargets';
import { SkillsSettings } from './SkillsSettings';

vi.mock('../../app/api', async importOriginal => ({ ...(await importOriginal<typeof import('../../app/api')>()), apiForTarget: vi.fn() }));
const mocked = vi.mocked(apiForTarget);
const targets: ApiTarget[] = [{ id: 'local', name: 'Local', baseUrl: '', enabled: true }, { id: 'remote', name: 'Remote', baseUrl: 'https://example.test', enabled: true }];
const agents = [{ id: 'remote::agent', name: 'Agent' }] as Agent[];
const skill = { id: 'review', name: 'Review', description: 'Review changes', content: '# Review', lifecycle: 'available', global: false, source: 'sqlite', version: 'sha256:123' };
const grants = { assignedSkillIds: [], globalSkillIds: [], effectiveSkills: [{ id: 'files', name: 'Files', description: 'Asset backed', lifecycle: 'available', available: true, sourcePath: '/skills/files/SKILL.md', ownership: { scope: 'agent', agentId: 'agent' } }] };
afterEach(() => { cleanup(); mocked.mockReset(); });

describe('shared Skills settings', () => {
  it('routes edits and selected-agent assignments to the owning target', async () => {
    mocked.mockImplementation(async (_target, path, init) => {
      if (init?.method) return {} as never;
      return (path === '/api/settings/skills' ? { skills: [skill] } : grants) as never;
    });
    const configuration = document.createElement('div'); const overflow = document.createElement('div'); document.body.append(configuration, overflow);
    const { unmount } = render(<SkillsSettings agents={agents} agentId={agents[0].id} targets={targets} configurationTarget={configuration} overflowTarget={overflow} />);
    fireEvent.click(await screen.findByRole('button', { name: /Review/ }));
    fireEvent.change(within(configuration).getByDisplayValue('# Review'), { target: { value: '# Revised' } });
    fireEvent.click(within(configuration).getByRole('button', { name: 'Save skill' }));
    await waitFor(() => expect(mocked).toHaveBeenCalledWith(targets[1], '/api/settings/skills/review', expect.objectContaining({ method: 'PATCH', body: expect.stringContaining('# Revised') })));
    fireEvent.click(within(overflow).getByRole('checkbox', { name: 'Agent' }));
    await waitFor(() => expect(mocked).toHaveBeenCalledWith(targets[1], '/api/agents/agent/skills', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ skillIds: ['review'] }) })));
    unmount(); configuration.remove(); overflow.remove();
  });

  it('shows effective filesystem skills without assignment or edit controls', async () => {
    mocked.mockImplementation(async (_target, path) => (path === '/api/settings/skills' ? { skills: [skill] } : grants) as never);
    const overflow = document.createElement('div'); document.body.append(overflow);
    const { unmount } = render(<SkillsSettings agentView agents={agents} agentId={agents[0].id} targets={targets} overflowTarget={overflow} />);
    await screen.findByText('Asset backed');
    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
    expect(within(overflow).getByText('/skills/files/SKILL.md')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Save skill|Delete skill/ })).toBeNull();
    unmount(); overflow.remove();
  });

  it('imports complete text for review without saving automatically', async () => {
    mocked.mockImplementation(async (_target, path, init) => {
      if (init?.method) return {} as never;
      return (path === '/api/settings/skills' ? { skills: [] } : { ...grants, effectiveSkills: [] }) as never;
    });
    const configuration = document.createElement('div'); document.body.append(configuration);
    const content = '# Imported\n' + 'complete content '.repeat(300);
    const { unmount } = render(<SkillsSettings agents={agents} agentId={agents[0].id} targets={targets} configurationTarget={configuration} />);
    const input = await within(configuration).findByLabelText('Import text skill');
    expect(input).toHaveProperty('className', 'skill-import-input');
    expect(within(configuration).getByRole('button', { name: 'Choose text file' })).toBeTruthy();
    expect(within(configuration).getByText('No file selected')).toBeTruthy();
    fireEvent.change(input, { target: { files: [new File([content], 'incident-response.markdown', { type: 'text/markdown' })] } });
    await waitFor(() => expect(within(configuration).getByLabelText('Content')).toHaveProperty('value', content));
    expect(within(configuration).getByText('incident-response.markdown')).toBeTruthy();
    expect(within(configuration).getByLabelText('ID')).toHaveProperty('value', 'incident-response');
    expect(within(configuration).getByLabelText('Name')).toHaveProperty('value', 'Incident Response');
    expect(mocked.mock.calls.some(([, path, init]) => path === '/api/settings/skills' && init?.method === 'POST')).toBe(false);
    fireEvent.click(within(configuration).getByRole('button', { name: 'Create skill' }));
    await waitFor(() => {
      const call = mocked.mock.calls.find(([, path, init]) => path === '/api/settings/skills' && init?.method === 'POST');
      expect(JSON.parse(String(call?.[2]?.body))).toMatchObject({ id: 'incident-response', name: 'Incident Response', content });
    });
    unmount(); configuration.remove();
  });

  it('rejects unsupported imports and reports file read errors', async () => {
    mocked.mockImplementation(async (_target, path) => (path === '/api/settings/skills' ? { skills: [] } : { ...grants, effectiveSkills: [] }) as never);
    const configuration = document.createElement('div'); document.body.append(configuration);
    const { unmount } = render(<SkillsSettings agents={agents} agentId={agents[0].id} targets={targets} configurationTarget={configuration} />);
    const input = await within(configuration).findByLabelText('Import text skill');
    fireEvent.change(input, { target: { files: [new File(['zip'], 'skill.zip')] } });
    expect((await screen.findByRole('alert')).textContent).toContain('Markdown or plain-text');
    const unreadable = new File(['secret'], 'skill.md', { type: 'text/markdown' });
    Object.defineProperty(unreadable, 'text', { value: vi.fn().mockRejectedValue(new Error('read failed')) });
    fireEvent.change(input, { target: { files: [unreadable] } });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Could not read “skill.md”'));
    unmount(); configuration.remove();
  });

  it('creates a global text skill with complete content', async () => {
    mocked.mockImplementation(async (_target, path, init) => {
      if (init?.method) return {} as never;
      return (path === '/api/settings/skills' ? { skills: [] } : { ...grants, effectiveSkills: [] }) as never;
    });
    const configuration = document.createElement('div'); document.body.append(configuration);
    const longContent = '# Shared\n' + 'full text '.repeat(200);
    const { unmount } = render(<SkillsSettings agents={agents} agentId={agents[0].id} targets={targets} configurationTarget={configuration} />);
    await within(configuration).findByRole('button', { name: 'Create skill' });
    fireEvent.change(within(configuration).getByLabelText('ID'), { target: { value: 'shared' } });
    fireEvent.change(within(configuration).getByLabelText('Name'), { target: { value: 'Shared' } });
    fireEvent.change(within(configuration).getByLabelText('Content'), { target: { value: longContent } });
    fireEvent.click(within(configuration).getByRole('checkbox', { name: 'Assign globally' }));
    fireEvent.click(within(configuration).getByRole('button', { name: 'Create skill' }));
    await waitFor(() => {
      const call = mocked.mock.calls.find(([, path, init]) => path === '/api/settings/skills' && init?.method === 'POST');
      expect(call).toBeTruthy();
      expect(JSON.parse(String(call?.[2]?.body))).toMatchObject({ id: 'shared', name: 'Shared', content: longContent, global: true });
    });
    unmount(); configuration.remove();
  });
});
