import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../../app/api';
import { ConfirmProvider } from '../../app/ConfirmDialog';
import type { Agent } from '../../app/types';
import { AgentSettings } from './AgentSettings';
vi.mock('../../app/api', async original => ({ ...await original<typeof import('../../app/api')>(), api: vi.fn() }));
afterEach(cleanup);
it('preserves name enabled and avatar drafts on fresh same-owner registry objects but resets on owner switch', async () => {
 const agent = { id: 'a', name: 'Alpha', avatar: 'data:image/png;base64,AA', activity: 'Idle' } as Agent;
 let registry = { id: agent.id, name: agent.name, enabled: true };
 let identity = { id: agent.id, name: agent.name, avatar: agent.avatar };
 vi.mocked(api).mockImplementation(async (path, init) => {
  if (path.endsWith('/minion-model-selection')) return { ok: true, selection: null };
  if (path.endsWith('/minion-settings')) return { ok: true, maxDepth: 1 };
  const body = JSON.parse(init?.body as string);
  if (path === '/api/agents/a' && init?.method === 'PATCH') {
   registry = { ...registry, ...body };
   return { ok: true, agent: { ...registry } };
  }
  if (path === '/api/settings/identities' && init?.method === 'PUT') {
   identity = { ...identity, ...body };
   return { ok: true, agents: [{ ...identity }] };
  }
  throw new Error(`Unexpected API request: ${init?.method ?? 'GET'} ${path}`);
 });
 const view = (selected: Agent) => <ConfirmProvider><AgentSettings selected={selected} savedProviders={[]} onAgentsChanged={async () => {}} section="details" /></ConfirmProvider>;
 const { rerender } = render(view(agent));
 fireEvent.change(screen.getByDisplayValue('Alpha'), { target: { value: 'Draft' } });
 fireEvent.click(screen.getByRole('checkbox', { name: 'Enabled' }));
 await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Enabled' })).toHaveProperty('disabled', false));
 fireEvent.click(screen.getByRole('button', { name: 'Remove image' }));
 await waitFor(() => expect(screen.getByLabelText('Displayed name')).toHaveProperty('disabled', false));
 rerender(view({ ...agent }));
 expect(screen.getByDisplayValue('Draft')).toBeTruthy();
 expect((screen.getByRole('checkbox', { name: 'Enabled' }) as HTMLInputElement).checked).toBe(false);
 expect(screen.queryByRole('button', { name: 'Remove image' })).toBeNull();
 fireEvent.blur(screen.getByLabelText('Displayed name'));
 await screen.findByText('Agent details saved.');
 expect(vi.mocked(api)).toHaveBeenCalledWith('/api/agents/a', expect.objectContaining({method:'PATCH',body:JSON.stringify({enabled:false})}));
 expect(vi.mocked(api)).toHaveBeenCalledWith('/api/settings/identities', expect.objectContaining({method:'PUT',body:JSON.stringify({kind:'agent',id:'a',avatar:''})}));
 expect(vi.mocked(api)).toHaveBeenCalledWith('/api/settings/identities', expect.objectContaining({method:'PUT',body:JSON.stringify({kind:'agent',id:'a',name:'Draft'})}));
 rerender(view({ ...agent, id: 'b', name: 'Beta' }));
 expect(screen.getByDisplayValue('Beta')).toBeTruthy();
});
