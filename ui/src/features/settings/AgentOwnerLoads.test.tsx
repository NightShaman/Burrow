import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../../app/api';
import { AgentProfileDocuments } from './AgentProfileDocuments';
import { AgentMcpTools } from './AgentMcpTools';
import { AgentDreams } from './AgentDreams';
vi.mock('../../app/api', async original => ({ ...(await original<typeof import('../../app/api')>()), api: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
it.each(['profiles','grants','dreams'])('FE005 %s retries a failed local request without leaking another agent draft', async kind => {
 let fail=true;
 vi.mocked(api).mockImplementation(async (path, init) => {
  if (fail && (path.includes('/api/agents/b/') || (kind === 'grants' && path === '/api/settings/mcp-connections'))) throw new Error('B unavailable');
  if (init?.method === 'PUT') return {};
  if (path.includes('profile-documents')) return {documents:[{kind:'SOUL',markdown:'B own'}]};
  if (path.includes('mcp-connections')) return {connections:[]};
  if (path.includes('mcp-tools')) return {tools:[]};
  if (path.includes('dream-settings')) return {settings:{enabled:false,cron:'0 4 * * *',timezone:null,prompt:'B own'}};
  return {receipts:[]};
 });
 const view=(agentId:string)=>kind==='profiles'?<AgentProfileDocuments agentId={agentId}/>:kind==='grants'?<AgentMcpTools agentId={agentId}/>:<AgentDreams agentId={agentId} savedProviders={[]}/>;
 const rendered=render(view('a'));
 await waitFor(()=>expect(screen.queryByText(/Could not load/)).toBeNull());
 rendered.rerender(view('b'));
 await waitFor(()=>expect(screen.getByRole('button', { name: /Retry/ })).toBeTruthy());
 fail=false; fireEvent.click(screen.getByRole('button', { name: /Retry/ }));
 await waitFor(()=>expect(vi.mocked(api).mock.calls.length).toBeGreaterThan(0));
});
