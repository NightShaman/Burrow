import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../../app/api';
import { UnsavedChangesProvider, useUnsavedNavigation } from '../../app/UnsavedChanges';
import { MinionDepthSettings } from './MinionDepthSettings';
import { DreamPromotionSettings } from './DreamPromotionSettings';
import { BrowserOriginSettings } from './BrowserOriginSettings';
vi.mock('../../app/api', () => ({ api: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const origin = {ok:true,settings:{checkOrigin:true},effective:{checkOrigin:true,source:'database',allowedOrigins:[]}};
const scopes = [
 {name:'depth', element:<MinionDepthSettings resourceId="a"/>, role:'slider', label:'Maximum minion depth', initial:{ok:true,maxDepth:1}, accepted:{ok:true,maxDepth:2}, change:(node:HTMLElement)=>fireEvent.change(node,{target:{value:'2'}})},
 {name:'promotion',element:<DreamPromotionSettings/>,role:'checkbox',label:'Promote Dreams to memory',initial:{promoteDreamsToMemory:true},accepted:{promoteDreamsToMemory:false},change:(node:HTMLElement)=>fireEvent.click(node)},
 {name:'origin',element:<BrowserOriginSettings/>,role:'checkbox',label:'Check browser origin',initial:origin,accepted:{...origin,settings:{checkOrigin:false}},change:(node:HTMLElement)=>fireEvent.click(node)},
];
function Leave({leave}:{leave:()=>void}) { const navigate=useUnsavedNavigation(); return <button onClick={()=>navigate(leave)}>Leave</button>; }
it.each(scopes)('$name blocks navigation during save and rejects malformed response', async scope => {
 let release!: (value: unknown)=>void; vi.mocked(api).mockResolvedValueOnce(scope.initial).mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
 const leave=vi.fn(); render(<UnsavedChangesProvider>{scope.element}<Leave leave={leave}/></UnsavedChangesProvider>);
 const input=screen.getByRole(scope.role,{name:scope.label}) as HTMLInputElement; await waitFor(()=>expect(input.disabled).toBe(false));
 scope.change(input); expect(input.disabled).toBe(true); fireEvent.click(screen.getByText('Leave')); expect(leave).not.toHaveBeenCalled(); expect(screen.queryByRole('alertdialog')).toBeNull();
 await act(async()=>release({})); await screen.findByRole('alert'); expect(input.disabled).toBe(false); fireEvent.click(screen.getByText('Leave')); expect(screen.getByRole('alertdialog')).toBeTruthy(); expect(leave).not.toHaveBeenCalled();
});
it.each(scopes.slice(1))('$name clears failure on returning to baseline without another PUT', async scope => {
 vi.mocked(api).mockResolvedValueOnce(scope.initial).mockRejectedValueOnce(new Error('offline'));
 render(scope.element); const input=screen.getByRole(scope.role,{name:scope.label}) as HTMLInputElement; await waitFor(()=>expect(input.disabled).toBe(false));
 scope.change(input); await screen.findByRole('alert'); scope.change(input); expect(screen.queryByRole('alert')).toBeNull(); expect(screen.queryByText(/settings saved.|setting saved and applied./i)).toBeNull(); expect(api).toHaveBeenCalledTimes(2);
});
