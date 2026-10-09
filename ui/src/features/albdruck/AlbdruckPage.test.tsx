import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Brains, type Brain } from './AlbdruckPage';
import { api } from '../../app/api';
vi.mock('../../app/api', () => ({ api: vi.fn(), jsonMutation: (method: string, body?: unknown) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) }));
afterEach(() => { cleanup(); vi.resetAllMocks(); window.history.replaceState(null, '', '/'); });
const brain = (patch: Partial<Brain> = {}): Brain => ({ id:'b1',agentId:'a',title:'Remember this',content:'content',sourceRefs:['ref'],revision:1,operatorOwned:true,createdAt:'2026-01-01',updatedAt:'2026-01-01',origin:'explicit_saved_memory',legacyStatus:null,legacySnapshot:null,...patch });
const agents = [{id:'a',name:'Agent A'},{id:'b',name:'Agent B'}] as never;

describe('Brains workspace', () => {
  it('fences owner interleavings and keeps agentId in the URL', async () => {
    let resolveA!: (value: unknown) => void;
    vi.mocked(api).mockImplementation(async path => path.includes('agentId=a') ? new Promise(resolve => { resolveA=resolve; }) : {items:[brain({id:'b1',agentId:'b',title:'B memory'})],nextCursor:null});
    render(<Brains agents={agents} />);
    fireEvent.change(screen.getByLabelText('Agent owner'), {target:{value:'b'}});
    expect(await screen.findByText('B memory')).toBeTruthy();
    resolveA({items:[brain({title:'A memory'})],nextCursor:null});
    await waitFor(() => expect(screen.queryByText('A memory')).toBeNull());
    expect(window.location.search).toContain('agentId=b');
  });
  it('creates, updates, and deletes with the selected owner and expected revision', async () => {
    const saved = brain();
    vi.mocked(api).mockImplementation(async (_path, init) => !init ? {items:[],nextCursor:null} : init.method === 'POST' ? saved : init.method === 'PUT' ? {...saved,revision:2,title:'Changed'} : {...saved,revision:3});
    render(<Brains agents={agents} />); await screen.findByText('No saved brains for this agent.');
    fireEvent.click(screen.getByText('New brain')); fireEvent.change(screen.getByLabelText('Title'),{target:{value:'Remember this'}}); fireEvent.change(screen.getByLabelText('Content'),{target:{value:'content'}}); fireEvent.click(screen.getByText('Create brain'));
    await screen.findByText(/revision 1/); fireEvent.change(screen.getByLabelText('Title'),{target:{value:'Changed'}}); fireEvent.click(screen.getByText('Save brain'));
    await waitFor(() => expect(vi.mocked(api).mock.calls.some(([,i]) => i?.method === 'PUT' && JSON.parse(i.body as string).expectedRevision === 1)).toBe(true));
    fireEvent.click(screen.getByText('Delete brain'));
    await waitFor(() => expect(vi.mocked(api).mock.calls.some(([,i]) => i?.method === 'DELETE' && JSON.parse(i.body as string).expectedRevision === 2)).toBe(true));
    expect(vi.mocked(api).mock.calls.filter(([,i]) => i).every(([path]) => path.includes('agentId=a'))).toBe(true);
  });
  it('uses items/nextCursor pagination and preserves query in cursor requests', async () => {
    vi.mocked(api).mockImplementation(async path => path.includes('cursor=opaque') ? {items:[brain({id:'b2',title:'Page two'})],nextCursor:null} : {items:[brain()],nextCursor:'opaque'});
    render(<Brains agents={agents} />); await screen.findByText('Remember this');
    fireEvent.change(screen.getByLabelText('Search brains'),{target:{value:'needle'}}); fireEvent.click(screen.getByText('Search'));
    await screen.findByText('Next page'); fireEvent.click(screen.getByText('Next page')); await screen.findByText('Page two');
    expect(vi.mocked(api).mock.calls.some(([path]) => path.includes('query=needle') && path.includes('cursor=opaque') && path.includes('agentId=a'))).toBe(true);
  });
  it('reports revision conflicts, preserves the draft, and deliberately reloads detail', async () => {
    const migrated = brain({origin:'migrated_albdruck',legacyStatus:'active',legacySnapshot:{knowledge:{id:'old'}}});
    const fresh = brain({revision:2,title:'Server title',content:'server content'});
    vi.mocked(api).mockImplementation(async (path, init) => { if (init?.method === 'PUT') throw new Error('409 brain_revision_conflict_or_operator_authority'); if (path.startsWith('/api/brains/b1')) return fresh; return {items:[migrated],nextCursor:null}; });
    render(<Brains agents={agents} />); fireEvent.click(await screen.findByText('Remember this'));
    expect(screen.getByText('Origin: Migrated from legacy Albdruck')).toBeTruthy(); fireEvent.click(screen.getByText('Legacy migration details')); expect(screen.getByText('Status: active')).toBeTruthy(); expect(screen.getByText(/"old"/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Title'), {target:{value:'My draft'}}); fireEvent.click(screen.getByText('Save brain'));
    expect(await screen.findByText('Reload brain')).toBeTruthy(); expect(screen.getByLabelText('Title')).toHaveProperty('value','My draft');
    fireEvent.click(screen.getByText('Reload brain')); await waitFor(() => expect(screen.getByLabelText('Title')).toHaveProperty('value','Server title'));
    expect(vi.mocked(api).mock.calls.some(([path, init]) => path === '/api/brains/b1?agentId=a' && !init?.method)).toBe(true);
  });
  it('retries a failed first-page list request even when cursor and search are unchanged', async () => {
    vi.mocked(api).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({items:[brain()],nextCursor:null});
    render(<Brains agents={agents} />); expect(await screen.findByText('Retry')).toBeTruthy();
    fireEvent.click(screen.getByText('Retry')); expect(await screen.findByText('Remember this')).toBeTruthy();
    expect(vi.mocked(api)).toHaveBeenCalledTimes(2);
  });
  it('fences a delayed save when its owner disappears and does not overwrite the replacement owner', async () => {
    let resolveSave!: (value: Brain) => void;
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (init?.method === 'PUT') return new Promise(resolve => { resolveSave=resolve; });
      return path.includes('agentId=b') ? {items:[brain({id:'b2',agentId:'b',title:'B memory'})],nextCursor:null} : {items:[brain()],nextCursor:null};
    });
    const view = render(<Brains agents={agents} />); fireEvent.click(await screen.findByText('Remember this')); fireEvent.click(screen.getByText('Save brain'));
    expect(screen.getByLabelText('Title')).toHaveProperty('disabled', true); expect(screen.getByLabelText('Agent owner')).toHaveProperty('disabled', true);
    view.rerender(<Brains agents={[{id:'b',name:'Agent B'}] as never} />); expect(await screen.findByText('B memory')).toBeTruthy();
    resolveSave(brain({revision:2,title:'Late A save'})); await waitFor(() => expect(screen.queryByText('Late A save')).toBeNull());
    expect(screen.queryByLabelText('Brain editor')).toBeNull(); expect(window.location.search).toContain('agentId=b');
  });
  it('ignores a delayed detail reload after unmount', async () => {
    let resolveDetail!: (value: Brain) => void;
    vi.mocked(api).mockImplementation(async (path) => path.startsWith('/api/brains/b1') ? new Promise(resolve => { resolveDetail=resolve; }) : {items:[brain()],nextCursor:null});
    const view = render(<Brains agents={agents} />); fireEvent.click(await screen.findByText('Remember this'));
    // Produce a conflict control by replacing the API behavior for the write only.
    vi.mocked(api).mockImplementation(async (path, init) => { if (init?.method === 'PUT') throw new Error('conflict'); if (path.startsWith('/api/brains/b1')) return new Promise(resolve => { resolveDetail=resolve; }); return {items:[brain()],nextCursor:null}; });
    fireEvent.click(screen.getByText('Save brain')); fireEvent.click(await screen.findByText('Reload brain')); view.unmount(); resolveDetail(brain({revision:2}));
    await Promise.resolve();
  });
});
