import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Albdruck, parseDays, parseDocument } from './AlbdruckPage';
import { apiForTarget } from '../../app/api';
vi.mock('../../app/api', () => ({ apiForTarget: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const item = {id:'k',document:{claim:'Use PG',rationale:null,alternatives:[],constraints:[],relationships:[]},state:'active',updated_at:'2026-01-01T00:00:00Z'};
function mockApi() { vi.mocked(apiForTarget).mockImplementation(async (_target,path) => {
  if (path.endsWith('retention')) return {knowledgeDays:null,evidenceDays:30,revisionDays:null};
  if (path.includes('/knowledge/k?')) return {...item,evidence:[{status:'live_original',sourceRef:{kind:'conversation_entry'},content:'original'},{status:'preserved_excerpt',content:'excerpt'},{status:'unavailable',content:null}],revisions:[]};
  if (path.includes('/history')) return {items:[],nextCursor:null};
  return {items:[item],nextCursor:'k'};
}); }
describe('Albdruck',()=>{
  it('validates exact correction document and independent retention',()=>{
    expect(parseDocument('{"claim":" x "}')).toEqual({claim:'x',rationale:null,alternatives:[],constraints:[],relationships:[]});
    expect(()=>parseDocument('{"claim":"x","constraints":"bad"}')).toThrow();
    expect(()=>parseDocument('{"claim":" "}')).toThrow();
    expect(parseDays('')).toBe(null); expect(parseDays('30')).toBe(30);
    for(const text of ['0','-1','1.5','bad']) expect(()=>parseDays(text)).toThrow();
  });
  it('uses scope, cursor and review contracts; distinguishes evidence',async()=>{
    mockApi(); render(<Albdruck agents={[]}/>);
    fireEvent.change(screen.getByLabelText('Scope'),{target:{value:'global'}});
    fireEvent.click(await screen.findByText('Use PG'));
    expect(await screen.findByText('Original conversation')).toBeTruthy();
    expect(screen.getByText('Preserved excerpt')).toBeTruthy(); expect(screen.getByText('Unavailable')).toBeTruthy();
    expect((screen.getByText('Apply correct') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Reason (required)'),{target:{value:'Verified correction'}});
    fireEvent.click(screen.getByText('Apply correct'));
    await waitFor(()=>expect(vi.mocked(apiForTarget).mock.calls.some(c=>c[2]?.method==='PUT' && JSON.parse(c[2].body as string).reason==='Verified correction')).toBe(true));
    await waitFor(()=>expect(screen.getByText('Next page')).toBeTruthy());
    fireEvent.click(screen.getByText('Next page'));
    await waitFor(()=>expect(vi.mocked(apiForTarget).mock.calls.some(c=>c[1].includes('cursor=k'))).toBe(true));
    fireEvent.change(screen.getByLabelText('View'),{target:{value:'recall'}});
    expect(screen.getByText(/full original conversation entries/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Search originals'),{target:{value:'original'}});
    fireEvent.click(screen.getByText('Search'));
    await waitFor(()=>expect(vi.mocked(apiForTarget).mock.calls.some(c=>c[1].includes('/history?scope=global') && c[2]?.method==='POST' && JSON.parse(c[2].body as string).query==='original')).toBe(true));
  });
  it('paginates full originals and labels live and reset archives without knowledge requests',async()=>{
    const original = {agentId:'a',sessionId:'s',entryId:'e',timestamp:'2026-01-01T00:00:00Z',role:'user',content:'Complete original\nsecond line',sourceRef:{kind:'conversation_entry',agentId:'a',sessionId:'s',entryId:'e'},provenance:{store:'archive',reset:true,archiveId:'archive-1'}};
    vi.mocked(apiForTarget).mockImplementation(async (_t,path,init)=> path.endsWith('retention') ? {knowledgeDays:null,evidenceDays:null,revisionDays:null} : path.includes('/history') ? JSON.parse(init?.body as string).cursor ? {items:[{...original,entryId:'f',provenance:{store:'live',reset:false}}],nextCursor:null} : {items:[original],nextCursor:'opaque'} : {items:[],nextCursor:null});
    render(<Albdruck agents={[]}/>); fireEvent.change(screen.getByLabelText('Scope'),{target:{value:'global'}}); fireEvent.change(screen.getByLabelText('View'),{target:{value:'recall'}});
    expect(screen.getByText('Search') as HTMLButtonElement).toHaveProperty('disabled',true);
    fireEvent.change(screen.getByLabelText('Search originals'),{target:{value:'original'}}); fireEvent.click(screen.getByText('Search'));
    expect(await screen.findByText(/Complete original second line/)).toBeTruthy(); expect(screen.getByText('Original conversation · Reset archive')).toBeTruthy();
    fireEvent.click(screen.getByText('Next page')); await screen.findByText('Original conversation · Live');
    expect(vi.mocked(apiForTarget).mock.calls.some(c=>c[1].includes('/history?scope=global') && JSON.parse(c[2]?.body as string).cursor==='opaque')).toBe(true);
    expect(vi.mocked(apiForTarget).mock.calls.some(c=>c[1].includes('/recall?'))).toBe(false);
  });
  it('ignores a stale list response after scope change',async()=>{
    let resolveOld!: (value: unknown)=>void;
    vi.mocked(apiForTarget).mockImplementation(async (_t,path)=>path.endsWith('retention') ? {knowledgeDays:null,evidenceDays:null,revisionDays:null} : path.includes('scope=agent') ? new Promise(r=>{resolveOld=r;}) : {items:[],nextCursor:null});
    render(<Albdruck agents={[{id:'a',name:'A'} as never]}/>);
    fireEvent.change(screen.getByLabelText('Scope'),{target:{value:'global'}});
    await screen.findByText('No matching knowledge.');
    await act(async()=>resolveOld({items:[item],nextCursor:null}));
    expect(screen.queryByText('Use PG')).toBe(null);
  });
});
