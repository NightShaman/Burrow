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
    expect(screen.getByText(/not historical conversations/)).toBeTruthy();
    await waitFor(()=>expect(vi.mocked(apiForTarget).mock.calls.some(c=>c[1].includes('/recall?scope=global') && c[2]?.method==='POST')).toBe(true));
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
