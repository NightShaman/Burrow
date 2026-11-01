import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api } from '../../app/api';
import type { SavedProvider } from '../../app/types';
import { DefaultMinionModel } from './DefaultMinionModel';
vi.mock('../../app/api',()=>({api:vi.fn()}));
const native: SavedProvider = { id:'p',provider:'Native',apiType:'anthropic-messages',url:'',apiKey:'',models:['native','manual'],modelEfforts:{native:['low','high','xhigh']},connectionModels:[{id:'native',thinkingModes:['default','adaptive','between_tools'],thinkingEfforts:{default:['low','high','max'],adaptive:['low','high','max'],between_tools:['low','high']}},{id:'manual',thinkingModes:['default','disabled','enabled'],thinkingEfforts:{default:[],disabled:[],enabled:[]}}]};
const base = {connectionId:'p',model:'native',thinkingMode:null as string|null,reasoningEffort:'off',temperature:0.2};
const puts=()=>vi.mocked(api).mock.calls.filter(([,init])=>init?.method==='PUT');
const mode=()=>screen.getByLabelText('Minion thinking mode') as HTMLSelectElement;
const effort=()=>screen.getByLabelText('Minion reasoning effort') as HTMLSelectElement;
const ready=()=>waitFor(()=>expect(mode().disabled).toBe(false));
afterEach(cleanup);beforeEach(()=>vi.mocked(api).mockReset());
it('loads unsupported legacy Off raw and editable without writing, then saves explicit Adaptive/Default',async()=>{
 vi.mocked(api).mockResolvedValueOnce({ok:true,selection:base}).mockResolvedValueOnce({ok:true,selection:{...base,thinkingMode:'adaptive'}});
 render(<DefaultMinionModel resourceId="a" savedProviders={[native]} />);await ready();
 expect(mode().value).toBe('');expect(mode().selectedOptions[0].text).toContain('Off (unsupported)');expect(puts()).toHaveLength(0);
 expect(screen.getByLabelText('Minion temperature')).toHaveProperty('disabled',true);
 fireEvent.change(mode(),{target:{value:'adaptive'}});await screen.findByText('Default minion model saved.');
 expect(JSON.parse(puts()[0][1]!.body as string)).toEqual({...base,thinkingMode:'adaptive'});
 expect(effort().selectedOptions[0].text).toBe('Default');expect(screen.getByLabelText('Minion temperature')).toHaveProperty('disabled',false);
});
it('stages incompatible mode without rewriting effort and saves the pair only after explicit correction',async()=>{
 const selected={...base,thinkingMode:'adaptive',reasoningEffort:'max'};
 vi.mocked(api).mockResolvedValueOnce({ok:true,selection:selected}).mockResolvedValueOnce({ok:true,selection:{...selected,thinkingMode:'between_tools',reasoningEffort:'high'}});
 render(<DefaultMinionModel resourceId="a" savedProviders={[native]} />);await ready();
 fireEvent.change(mode(),{target:{value:'between_tools'}});
 expect(effort().value).toBe('max');expect(screen.getByText(/Saved effort.*max/)).toBeTruthy();expect(puts()).toHaveLength(0);
 fireEvent.change(effort(),{target:{value:'high'}});await screen.findByText('Default minion model saved.');
 expect(JSON.parse(puts()[0][1]!.body as string)).toEqual({...selected,thinkingMode:'between_tools',reasoningEffort:'high'});
});
it('retains failed native pair and retries it without reverting the chosen mode',async()=>{
 vi.mocked(api).mockResolvedValueOnce({ok:true,selection:{...base,thinkingMode:'default'}}).mockRejectedValueOnce(new Error('mode save rejected')).mockResolvedValueOnce({ok:true,selection:{...base,thinkingMode:'adaptive'}});
 render(<DefaultMinionModel resourceId="a" savedProviders={[native]} />);await ready();
 fireEvent.change(mode(),{target:{value:'adaptive'}});await screen.findByText(/mode save rejected/);
 expect(mode().value).toBe('adaptive');fireEvent.click(screen.getByRole('button',{name:'Retry saving minion thinking mode'}));
 await screen.findByText('Default minion model saved.');expect(puts()).toHaveLength(2);
 expect(JSON.parse(puts()[1][1]!.body as string)).toEqual({...base,thinkingMode:'adaptive'});
});
it('keeps failed identity separate and disables native pair edits until that identity is accepted',async()=>{
 vi.mocked(api).mockResolvedValueOnce({ok:true,selection:{...base,thinkingMode:'default'}}).mockRejectedValueOnce(new Error('model save rejected')).mockResolvedValueOnce({ok:true,selection:{...base,model:'manual',thinkingMode:'default'}});
 render(<DefaultMinionModel resourceId="a" savedProviders={[native]} />);await ready();
 fireEvent.change(screen.getByLabelText('Default minion model'),{target:{value:'manual'}});await screen.findByText(/model save rejected/);
 expect(mode().disabled).toBe(true);expect(effort().disabled).toBe(true);expect(puts()).toHaveLength(1);
 fireEvent.click(screen.getByRole('button',{name:'Retry saving minion model'}));await screen.findByText('Default minion model saved.');
 expect(mode().disabled).toBe(false);expect(mode().value).toBe('default');
 expect(JSON.parse(puts()[1][1]!.body as string)).toMatchObject({model:'manual',thinkingMode:'default',reasoningEffort:'off'});
});
it('clears to inherit with null/null only and no implicit explicit mode',async()=>{
 vi.mocked(api).mockResolvedValueOnce({ok:true,selection:{...base,thinkingMode:'adaptive'}}).mockResolvedValueOnce({ok:true,selection:null});
 render(<DefaultMinionModel resourceId="a" savedProviders={[native]} />);await ready();
 fireEvent.change(screen.getByLabelText('Default minion provider'),{target:{value:''}});await screen.findByText('Default minion model saved.');
 expect(JSON.parse(puts()[0][1]!.body as string)).toEqual({connectionId:null,model:null});expect(screen.queryByLabelText('Minion thinking mode')).toBeNull();
});
it('rejects silently substituted native acknowledgements',async()=>{
 vi.mocked(api).mockResolvedValueOnce({ok:true,selection:base}).mockResolvedValueOnce({ok:true,selection:{...base,thinkingMode:'default'}});
 render(<DefaultMinionModel resourceId="a" savedProviders={[native]} />);await ready();
 fireEvent.change(mode(),{target:{value:'adaptive'}});await screen.findByRole('alert');expect(mode().value).toBe('adaptive');expect(screen.queryByText('Default minion model saved.')).toBeNull();
});


it('supports native Anthropic pool modes without changing the legacy Off record on load',async()=>{
 vi.mocked(api).mockResolvedValueOnce({ok:true,selection:base});
 render(<DefaultMinionModel resourceId="a" savedProviders={[{...native,apiType:'anthropic-lb'}]} />);await ready();
 expect(mode().selectedOptions[0].text).toContain('Off (unsupported)');expect(puts()).toHaveLength(0);
});
it('keeps the native temperature editable across several changes and commits only at interaction end',async()=>{
 const selected={...base,thinkingMode:'adaptive'};
 vi.mocked(api).mockResolvedValueOnce({ok:true,selection:selected}).mockResolvedValueOnce({ok:true,selection:{...selected,temperature:1.2}});
 render(<DefaultMinionModel resourceId="a" savedProviders={[native]} />);await ready();
 const temperature=screen.getByLabelText('Minion temperature');
 fireEvent.pointerDown(temperature,{pointerId:1});fireEvent.change(temperature,{target:{value:'0.8'}});
 expect(temperature).toHaveProperty('disabled',false);fireEvent.change(temperature,{target:{value:'1.2'}});
 expect(puts()).toHaveLength(0);fireEvent.pointerUp(temperature,{pointerId:1});await screen.findByText('Default minion model saved.');
 expect(JSON.parse(puts()[0][1]!.body as string)).toEqual({...selected,temperature:1.2});
});
