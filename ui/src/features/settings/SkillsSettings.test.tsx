import { ConfirmProvider } from '../../app/ConfirmDialog';
import { cleanup, fireEvent, render as baseRender, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../app/api';
import type { Agent } from '../../app/types';
import { SkillsSettings } from './SkillsSettings';

vi.mock('../../app/api', async importOriginal => ({ ...(await importOriginal<typeof import('../../app/api')>()), api: vi.fn() }));
const mocked = vi.mocked(api);
const agents = [{ id: 'agent', name: 'Agent' }] as Agent[];
const skill = { id: 'review', name: 'Review', description: 'Review changes', content: '# Review', lifecycle: 'available', global: false, source: 'sqlite', version: 'sha256:123' };
const grants = { assignedSkillIds: [], globalSkillIds: [] };
afterEach(() => { cleanup(); mocked.mockReset(); });

describe('shared Skills settings', () => {
  it('routes shared edits and selected-agent assignments through local API', async () => {
    mocked.mockImplementation(async (path, init) => {
      if (init?.method) return {} as never;
      return (path === '/api/settings/skills' ? { skills: [skill] } : grants) as never;
    });
    const configuration = document.createElement('div'); const overflow = document.createElement('div'); document.body.append(configuration, overflow);
    const { unmount } = render(<SkillsSettings section="installed" agents={agents} agentId={agents[0].id} configurationTarget={configuration} overflowTarget={overflow} />);
    fireEvent.click(await screen.findByRole('button', { name: /Review/ }));
    fireEvent.change(within(configuration).getByDisplayValue('# Review'), { target: { value: '# Revised' } });
    fireEvent.click(within(configuration).getByRole('button', { name: 'Save skill' }));
    await waitFor(() => expect(mocked).toHaveBeenCalledWith( '/api/settings/skills/review', expect.objectContaining({ method: 'PATCH', body: expect.stringContaining('# Revised') })));
    fireEvent.click(within(configuration).getByRole('checkbox', { name: 'Agent' }));
    await waitFor(() => expect(mocked).toHaveBeenCalledWith( '/api/agents/agent/skills', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ skillIds: ['review'] }) })));
    unmount(); configuration.remove(); overflow.remove();
  });

  it('does not load or display filesystem-backed skills', async () => {
    mocked.mockImplementation(async (path) => (path === '/api/settings/skills' ? { skills: [skill] } : grants) as never);
    const overflow = document.createElement('div'); document.body.append(overflow);
    const { unmount } = render(<SkillsSettings agentView agents={agents} agentId={agents[0].id} overflowTarget={overflow} />);
    await screen.findByText('Review');
    expect(screen.queryByText(/Asset backed|SKILL\.md/i)).toBeNull();
    expect(overflow.childElementCount).toBe(0);
    unmount(); overflow.remove();
  });

  it('imports complete text for review without saving automatically', async () => {
    mocked.mockImplementation(async (path, init) => {
      if (init?.method) return {} as never;
      return (path === '/api/settings/skills' ? { skills: [] } : grants) as never;
    });
    const configuration = document.createElement('div'); document.body.append(configuration);
    const content = '# Imported\n' + 'complete content '.repeat(300);
    const { unmount } = render(<SkillsSettings section="text" agents={agents} agentId={agents[0].id} configurationTarget={configuration} />);
    const input = await within(configuration).findByLabelText('Import text skill');
    expect(input).toHaveProperty('className', 'skill-import-input');
    expect(within(configuration).getByRole('button', { name: 'Choose text file' })).toBeTruthy();
    expect(within(configuration).getByText('No file selected')).toBeTruthy();
    fireEvent.change(input, { target: { files: [new File([content], 'incident-response.markdown', { type: 'text/markdown' })] } });
    await waitFor(() => expect(within(configuration).getByLabelText('Content')).toHaveProperty('value', content));
    expect(within(configuration).getByText('incident-response.markdown')).toBeTruthy();
    expect(within(configuration).getByLabelText('ID')).toHaveProperty('value', 'incident-response');
    expect(within(configuration).getByLabelText('Name')).toHaveProperty('value', 'Incident Response');
    expect(mocked.mock.calls.some(([path, init]) => path === '/api/settings/skills' && init?.method === 'POST')).toBe(false);
    fireEvent.click(within(configuration).getByRole('button', { name: 'Create skill' }));
    await waitFor(() => {
      const call = mocked.mock.calls.find(([path, init]) => path === '/api/settings/skills' && init?.method === 'POST');
      expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({ id: 'incident-response', name: 'Incident Response', content });
    });
    unmount(); configuration.remove();
  });

  it('rejects unsupported imports and reports file read errors', async () => {
    mocked.mockImplementation(async (path) => (path === '/api/settings/skills' ? { skills: [] } : grants) as never);
    const configuration = document.createElement('div'); document.body.append(configuration);
    const { unmount } = render(<SkillsSettings section="text" agents={agents} agentId={agents[0].id} configurationTarget={configuration} />);
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
    mocked.mockImplementation(async (path, init) => {
      if (init?.method) return {} as never;
      return (path === '/api/settings/skills' ? { skills: [] } : grants) as never;
    });
    const configuration = document.createElement('div'); document.body.append(configuration);
    const longContent = '# Shared\n' + 'full text '.repeat(200);
    const { unmount } = render(<SkillsSettings section="text" agents={agents} agentId={agents[0].id} configurationTarget={configuration} />);
    await within(configuration).findByRole('button', { name: 'Create skill' });
    fireEvent.change(within(configuration).getByLabelText('ID'), { target: { value: 'shared' } });
    fireEvent.change(within(configuration).getByLabelText('Name'), { target: { value: 'Shared' } });
    fireEvent.change(within(configuration).getByLabelText('Content'), { target: { value: longContent } });
    fireEvent.click(within(configuration).getByRole('checkbox', { name: 'Assign globally' }));
    fireEvent.click(within(configuration).getByRole('button', { name: 'Create skill' }));
    await waitFor(() => {
      const call = mocked.mock.calls.find(([path, init]) => path === '/api/settings/skills' && init?.method === 'POST');
      expect(call).toBeTruthy();
      expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({ id: 'shared', name: 'Shared', content: longContent, global: true });
    });
    unmount(); configuration.remove();
  });
});

it('preserves skill drafts without catalog or assignment refetch on registry identity refresh', async () => {
 mocked.mockImplementation(async (path) => (path === '/api/settings/skills' ? { skills: [skill] } : grants) as never);
 const configuration = document.createElement('div'); document.body.append(configuration);
 const { rerender, unmount } = render(<SkillsSettings section="installed" agents={agents} agentId={agents[0].id} configurationTarget={configuration} />);
 fireEvent.click(await screen.findByRole('button', { name: /Review/ }));
 fireEvent.change(screen.getByDisplayValue('# Review'), { target: { value: '# Draft' } });
 const count = mocked.mock.calls.length;
 rerender(<SkillsSettings section="installed" agents={agents.map(agent => ({ ...agent }))} agentId={agents[0].id} configurationTarget={configuration} />);
 await waitFor(() => expect(mocked.mock.calls.length).toBe(count));
 expect(screen.getByDisplayValue('# Draft')).toBeTruthy();
 unmount(); configuration.remove();
});

it('preserves dirty content through membership/catalog refresh and saves that draft', async () => {
 let content = '# Review';
 mocked.mockImplementation(async (path, init) => (init?.method ? {} : path === '/api/settings/skills' ? {skills:[{...skill, content}]} : grants) as never);
 const configuration=document.createElement('div');document.body.append(configuration);
 const view=render(<SkillsSettings section="installed" agents={agents} agentId={agents[0].id} configurationTarget={configuration}/>);
 fireEvent.click(await screen.findByRole('button',{name:/^Review/}));
 fireEvent.change(screen.getByLabelText('Content'),{target:{value:'# Unsaved'}});
 content='# Updated catalog';
 view.rerender(<SkillsSettings section="installed" agents={[...agents,{id:'new',name:'New'} as Agent]} agentId={agents[0].id} configurationTarget={configuration}/>);
 await waitFor(()=>expect(mocked.mock.calls.some(([path])=>path==='/api/agents/new/skills')).toBe(true));
 await within(configuration).findByRole('button',{name:'Save skill'});
 expect(screen.getByLabelText('Content')).toHaveProperty('value','# Unsaved');
 fireEvent.click(screen.getByRole('button',{name:'Save skill'}));
 await waitFor(()=>expect(mocked).toHaveBeenCalledWith('/api/settings/skills/review',expect.objectContaining({method:'PATCH',body:expect.stringContaining('# Unsaved')})));
 view.unmount();configuration.remove();
});

function render(ui: Parameters<typeof baseRender>[0]) { return baseRender(ui, { wrapper: ConfirmProvider }); }

it('confirms shared skill deletion and does not delete on cancellation', async () => {
  mocked.mockImplementation(async (path, init) => (init?.method ? {} : path === '/api/settings/skills' ? { skills: [skill] } : grants) as never);
  const configuration = document.createElement('div'); document.body.append(configuration);
  const view = render(<SkillsSettings section="installed" agents={agents} agentId="agent" configurationTarget={configuration} />);
  fireEvent.click(await screen.findByRole('button', { name: /Review/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Delete skill' }));
  expect(screen.getByRole('alertdialog', { name: 'Delete skill?' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  expect(mocked.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Delete skill' }));
  fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete skill' }));
  await waitFor(() => expect(mocked).toHaveBeenCalledWith('/api/settings/skills/review', { method: 'DELETE' }));
  view.unmount(); configuration.remove();
});

it('uses the Settings primary surface and portals only the inventory', async () => {
 mocked.mockImplementation(async path => (path === '/api/settings/skills' ? {skills:[skill]} : path.endsWith('/source') ? {source:null} : grants) as never);
 const overflow=document.createElement('div'); document.body.append(overflow);
 const view=render(<SkillsSettings section="installed" agents={agents} agentId="agent" overflowTarget={overflow}/>);
 await within(overflow).findByRole('button',{name:/^Review/});
 expect(screen.queryByLabelText('Content')).toBeNull();
 fireEvent.click(within(overflow).getByRole('button',{name:/^Review/}));
 expect(screen.getByLabelText('Content')).toHaveProperty('value','# Review');
 expect(overflow.querySelector('textarea')).toBeNull();
 expect(within(overflow).queryByRole('button',{name:'Save skill'})).toBeNull();
 expect(screen.getByRole('checkbox',{name:'Agent'}).closest('.settings-overflow-content')).toBeNull();
 fireEvent.change(within(overflow).getByLabelText('Search skills'),{target:{value:'missing'}});
 expect(within(overflow).getByText('No skills match these filters.')).toBeTruthy();
 expect(screen.getByLabelText('Content')).toHaveProperty('value','# Review');
 view.unmount(); overflow.remove();
});
it('keeps upstream content out of editable fields and does not request evidence', async () => {
 const managed={...skill,contentOwner:'git',gitSource:{repository:'https://example.org/skills.git',ref:'main',path:'.',enabled:false,cron:null,timezone:'UTC',fetchTimeoutMs:120000}};
 mocked.mockImplementation(async path => (path === '/api/settings/skills' ? {skills:[managed]} : path.endsWith('/source') ? {source:managed.gitSource} : grants) as never);
 render(<SkillsSettings section="installed" agents={[]} agentId="agent"/>);
 fireEvent.click(await screen.findByRole('button',{name:/^Review/}));
 expect(screen.queryByLabelText('Content')).toBeNull();
 expect(screen.getByLabelText('Lifecycle')).toBeTruthy();
 expect(screen.getByLabelText('Repository')).toBeTruthy();
 expect(screen.getByText('No agents configured.')).toBeTruthy();
 expect(mocked.mock.calls.some(([path])=>/history|files/.test(path))).toBe(false);
 expect(screen.queryByText('Sync history')).toBeNull();
});
it('keeps repository import separate from text creation', async () => {
 mocked.mockImplementation(async path => (path === '/api/settings/skills' ? {skills:[]} : grants) as never);
 const view=render(<SkillsSettings section="repo" agents={[]} agentId="agent"/>);
 await screen.findByRole('button',{name:'Preview skill'});
 expect(screen.queryByLabelText('Name')).toBeNull();
 view.rerender(<SkillsSettings section="text" agents={[]} agentId="agent"/>);
 expect(screen.getByLabelText('Name')).toBeTruthy();
 expect(screen.getByRole('button',{name:'Create skill'})).toBeTruthy();
});

it('shows inventory only for Installed skills and restores it on return', async () => {
 mocked.mockImplementation(async path => (path === '/api/settings/skills' ? {skills:[skill]} : grants) as never);
 const overflow=document.createElement('div'); document.body.append(overflow);
 const view=render(<SkillsSettings section="installed" agents={[]} agentId="agent" overflowTarget={overflow}/>);
 await within(overflow).findByRole('button',{name:/^Review/});
 for (const section of ['repo','text'] as const) {
   view.rerender(<SkillsSettings section={section} agents={[]} agentId="agent" overflowTarget={overflow}/>);
   expect(overflow.childElementCount).toBe(0);
   expect(screen.queryByLabelText('Search skills')).toBeNull();
 }
 view.rerender(<SkillsSettings section="installed" agents={[]} agentId="agent" overflowTarget={overflow}/>);
 expect(within(overflow).getByRole('button',{name:/^Review/})).toBeTruthy();
 view.unmount(); overflow.remove();
});
