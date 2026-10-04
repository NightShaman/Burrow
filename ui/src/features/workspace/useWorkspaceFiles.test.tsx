import { act, renderHook, waitFor } from '@testing-library/react';
import type { Dispatch, SetStateAction } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../app/api';
import type { Tab } from '../../app/types';
import { useWorkspaceFiles } from './useWorkspaceFiles';
vi.mock('../../app/api', async (original) => ({ ...(await original<typeof import('../../app/api')>()), api: vi.fn() }));
const request = vi.mocked(api);
const setTabs: Dispatch<SetStateAction<Tab[]>> = vi.fn();
const setActiveTabId: Dispatch<SetStateAction<string>> = vi.fn();
function deferred<T>() { let resolve!: (value:T)=>void; const promise=new Promise<T>(r=>resolve=r); return {promise,resolve}; }
describe('useWorkspaceFiles local runtime', () => {
 beforeEach(()=>request.mockReset());
 it('does not poll until workspace panel is visible', async()=>{
  request.mockResolvedValue({files:[{path:'visible.txt',type:'file'}]});
  const {result,rerender}=renderHook(({pollingEnabled})=>useWorkspaceFiles({selectedAgentId:'agent-a',setTabs,setActiveTabId,pollingEnabled}),{initialProps:{pollingEnabled:false}});
  await act(async()=>{await Promise.resolve()}); expect(request).not.toHaveBeenCalled(); rerender({pollingEnabled:true});
  await waitFor(()=>expect(result.current.workspaceFiles).toEqual([{name:'visible.txt',path:'visible.txt',type:'file'}]));
 });
 it('retains the selected agent workspace when a prior response resolves late',async()=>{
  const first=deferred<{files:Array<{path:string;type:'file'}>}>();
  request.mockImplementation(async(path) => typeof path === 'string' && path.includes('agentId=agent-a') ? first.promise : {files:[{path:'agent-b.txt',type:'file'}]});
  const {result,rerender}=renderHook(({selectedAgentId})=>useWorkspaceFiles({selectedAgentId,setTabs,setActiveTabId}),{initialProps:{selectedAgentId:'agent-a'}});
  rerender({selectedAgentId:'agent-b'}); await waitFor(()=>expect(result.current.workspaceFiles).toEqual([{name:'agent-b.txt',path:'agent-b.txt',type:'file'}]));
  await act(async()=>{first.resolve({files:[{path:'agent-a.txt',type:'file'}]});await first.promise});
  expect(result.current.workspaceFiles).toEqual([{name:'agent-b.txt',path:'agent-b.txt',type:'file'}]);
 });
 it('reuses a loaded dirty tab without replacing its draft',async()=>{
  const tabs:Tab[]=[]; const update:Dispatch<SetStateAction<Tab[]>>=change=>{tabs.splice(0,tabs.length,...(typeof change==='function'?change(tabs):change))};
  request.mockResolvedValue({content:'server'}); const {result}=renderHook(()=>useWorkspaceFiles({selectedAgentId:'agent-a',tabs,setTabs:update,setActiveTabId,pollingEnabled:false}));
  const file={name:'a.txt',path:'a.txt',type:'file' as const}; await act(async()=>{await result.current.openFile(file)}); tabs[0]={...tabs[0],content:'draft'};
  await act(async()=>{await result.current.openFile(file)}); expect(tabs[0].content).toBe('draft'); expect(request).toHaveBeenCalledTimes(1);
 });
 it('does not overwrite edits made while a file read is pending',async()=>{
  const tabs:Tab[]=[]; const update:Dispatch<SetStateAction<Tab[]>>=change=>{tabs.splice(0,tabs.length,...(typeof change==='function'?change(tabs):change))}; const read=deferred<{content:string}>(); request.mockReturnValue(read.promise);
  const {result}=renderHook(()=>useWorkspaceFiles({selectedAgentId:'agent-a',tabs,setTabs:update,setActiveTabId,pollingEnabled:false})); let opening!:Promise<void>;
  act(()=>{opening=result.current.openFile({name:'a',path:'a',type:'file'})}); tabs[0]={...tabs[0],content:'new edit'};
  await act(async()=>{read.resolve({content:'old server'});await opening}); expect(tabs[0].content).toBe('new edit');
 });
});
