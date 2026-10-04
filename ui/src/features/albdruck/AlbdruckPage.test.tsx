import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Albdruck, parseDays, parseDocument } from './AlbdruckPage';
import { api } from '../../app/api';
vi.mock('../../app/api', () => ({ api: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const item = {id:'k',document:{claim:'Use PG',rationale:null,alternatives:[],constraints:[],relationships:[]},state:'active',updated_at:'2026-01-01T00:00:00Z'};
function mockApi() { vi.mocked(api).mockImplementation(async (path) => {
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
    await waitFor(()=>expect(vi.mocked(api).mock.calls.some(c=>c[1]?.method==='PUT' && JSON.parse(c[1]!.body as string).reason==='Verified correction')).toBe(true));
    await waitFor(()=>expect(screen.getByText('Next page')).toBeTruthy());
    fireEvent.click(screen.getByText('Next page'));
    await waitFor(()=>expect(vi.mocked(api).mock.calls.some(c=>c[0].includes('cursor=k'))).toBe(true));
    fireEvent.change(screen.getByLabelText('View'),{target:{value:'recall'}});
    expect(screen.getByText(/full original conversation entries/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Search originals'),{target:{value:'original'}});
    fireEvent.click(screen.getByText('Search'));
    await waitFor(()=>expect(vi.mocked(api).mock.calls.some(c=>c[0].includes('/history?scope=global') && c[1]?.method==='POST' && JSON.parse(c[1]!.body as string).query==='original')).toBe(true));
  });
  it('paginates full originals and labels live and reset archives without knowledge requests',async()=>{
    const original = {agentId:'a',sessionId:'s',entryId:'e',timestamp:'2026-01-01T00:00:00Z',role:'user',content:'Complete original\nsecond line',sourceRef:{kind:'conversation_entry',agentId:'a',sessionId:'s',entryId:'e'},provenance:{store:'archive',reset:true,archiveId:'archive-1'}};
    vi.mocked(api).mockImplementation(async (path,init)=> path.endsWith('retention') ? {knowledgeDays:null,evidenceDays:null,revisionDays:null} : path.includes('/history') ? JSON.parse(init?.body as string).cursor ? {items:[{...original,entryId:'f',provenance:{store:'live',reset:false}}],nextCursor:null} : {items:[original],nextCursor:'opaque'} : {items:[],nextCursor:null});
    render(<Albdruck agents={[]}/>); fireEvent.change(screen.getByLabelText('Scope'),{target:{value:'global'}}); fireEvent.change(screen.getByLabelText('View'),{target:{value:'recall'}});
    expect(screen.getByText('Search') as HTMLButtonElement).toHaveProperty('disabled',true);
    fireEvent.change(screen.getByLabelText('Search originals'),{target:{value:'original'}}); fireEvent.click(screen.getByText('Search'));
    expect(await screen.findByText(/Complete original second line/)).toBeTruthy(); expect(screen.getByText('Original conversation · Reset archive')).toBeTruthy();
    fireEvent.click(screen.getByText('Next page')); await screen.findByText('Original conversation · Live');
    expect(vi.mocked(api).mock.calls.some(c=>c[0].includes('/history?scope=global') && JSON.parse(c[1]?.body as string).cursor==='opaque')).toBe(true);
    expect(vi.mocked(api).mock.calls.some(c=>c[0].includes('/recall?'))).toBe(false);
  });
  it('roundtrips all six independent retention limits including null and explicit values', async () => {
    const keys = ['knowledgeDays','evidenceDays','revisionDays','conversationDays','operationalDays','attachmentDays'] as const;
    const initial = {knowledgeDays:null,evidenceDays:7,revisionDays:null,conversationDays:null,operationalDays:null,attachmentDays:30};
    vi.mocked(api).mockImplementation(async (path,init) => path.endsWith('retention') ? init?.method === 'PUT' ? JSON.parse(init.body as string) : initial : {items:[],nextCursor:null});
    render(<Albdruck agents={[]}/>);
    const labels = ['Derived knowledge (days)','Preserved evidence excerpts (days)','Knowledge revisions (days)','Original conversations (days)','Operational traces (days)','Attachments (days)'];
    for (let i=0;i<keys.length;i++) expect(await screen.findByLabelText(labels[i])).toHaveProperty('value',initial[keys[i]] === null ? '' : String(initial[keys[i]]));
    const values = [1,null,3,4,5,null];
    for (let i=0;i<keys.length;i++) fireEvent.change(screen.getByLabelText(labels[i]),{target:{value:values[i] === null ? '' : String(values[i])}});
    fireEvent.click(screen.getByText('Save retention'));
    await waitFor(() => expect(vi.mocked(api).mock.calls.find(c=>c[0].endsWith('retention') && c[1]?.method === 'PUT')).toBeTruthy());
    const call = vi.mocked(api).mock.calls.find(c=>c[0].endsWith('retention') && c[1]?.method === 'PUT')!;
    expect(JSON.parse(call[1]!.body as string)).toEqual(Object.fromEntries(keys.map((k,i)=>[k,values[i]])));
    expect(screen.queryByText(/conversations are not deleted/i)).toBeNull();
  });
  it('labels soft deletion Archive while preserving DELETE operation and reason', async () => {
    mockApi(); render(<Albdruck agents={[]}/>);
    fireEvent.change(screen.getByLabelText('Scope'),{target:{value:'global'}});
    fireEvent.click(await screen.findByText('Use PG'));
    fireEvent.change(await screen.findByLabelText('Operation'),{target:{value:'delete'}});
    expect(screen.getByText(/Archive is a soft deletion with a revision, not full erasure/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Reason (required)'),{target:{value:'Outdated'}});
    fireEvent.click(screen.getByText('Apply archive'));
    await waitFor(()=>expect(vi.mocked(api).mock.calls.some(c=>c[1]?.method==='DELETE' && JSON.parse(c[1]!.body as string).reason==='Outdated')).toBe(true));
  });
  it('ignores a stale list response after scope change',async()=>{
    let resolveOld!: (value: unknown)=>void;
    vi.mocked(api).mockImplementation(async (path)=>path.endsWith('retention') ? {knowledgeDays:null,evidenceDays:null,revisionDays:null} : path.includes('scope=agent') ? new Promise(r=>{resolveOld=r;}) : {items:[],nextCursor:null});
    render(<Albdruck agents={[{id:'a',name:'A'} as never]}/>);
    fireEvent.change(screen.getByLabelText('Scope'),{target:{value:'global'}});
    await screen.findByText('No matching knowledge.');
    await act(async()=>resolveOld({items:[item],nextCursor:null}));
    expect(screen.queryByText('Use PG')).toBe(null);
  });
});
