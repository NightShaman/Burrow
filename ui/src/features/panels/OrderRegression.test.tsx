import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AccountStatus, accountStatusOrderKey } from './AccountStatus';
import { readAccountOrder, writeAccountOrder } from '../../app/accountOrderStorage';
import { completeAgentOrder, mergeVisibleOrder, orderAgents } from '../../app/useAgentRailPreferences';
import { AgentSidebarSettings } from '../settings/AgentSidebarSettings';
import type { Agent } from '../../app/types';
vi.mock('../../app/api', () => ({api:vi.fn(() => new Promise(() => {}))}));
afterEach(cleanup);
it('preserves account order across empty/loading and other-node inventories', async () => {
 writeAccountOrder(accountStatusOrderKey,['b','a','remote']);
 const view = render(<AccountStatus providers={[]}/>);
 expect(readAccountOrder(accountStatusOrderKey)).toEqual(['b','a','remote']);
 view.rerender(<AccountStatus providers={[{id:'a',provider:'OpenAI',apiType:'openai-responses',oauthConfigured:true,apiKey:'',url:'',models:[]}]}/>);
 await waitFor(() => expect(view.container.querySelector('article')).toBeTruthy());
 expect(readAccountOrder(accountStatusOrderKey)).toEqual(['b','a','remote']);
});
it('empty and other-node agent inventory cannot prune hidden IDs', () => {
 expect(completeAgentOrder([],['b','a'])).toEqual(['b','a']);
 expect(completeAgentOrder([{id:'c'} as Agent],['b','a'])).toEqual(['b','a','c']);
 const setPreferences = vi.fn();
 render(<AgentSidebarSettings agents={[]} preferences={{view:'regular',order:['b','a']}} setPreferences={setPreferences}/>);
 expect(setPreferences).not.toHaveBeenCalled();
});

it('reorders only visible IDs and retains hidden owner preferences', () => {
 expect(mergeVisibleOrder(['a','remote','b'],['b','a'])).toEqual(['b','remote','a']);
 expect(mergeVisibleOrder(['remote'],['b','a'])).toEqual(['remote','b','a']);
 expect(mergeVisibleOrder(['remote'],[])).toEqual(['remote']);
 expect(orderAgents([{id:'a'} as Agent,{id:'b'} as Agent],['b','remote','a']).map(a => a.id)).toEqual(['b','a']);
});
