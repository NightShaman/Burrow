import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AgentToolbar } from './AgentToolbar';
import { api } from '../../app/api';
vi.mock('../../app/api', async original => ({...await original<typeof import('../../app/api')>(),api:vi.fn()}));
afterEach(cleanup);
it.each([true,false])('FE011 existing connection is normalized firstRun=%s', async firstRun => {
 vi.mocked(api).mockImplementation(async (path) => path === '/api/agents' ? {agent:{id:'agent'}} : {connections:[{id:'p',provider:'Example',models:[{id:'m',selected:true},{id:'off',selected:false}]}]});
 await act(async () => {render(<AgentToolbar agents={[]} selectedId="" onSelect={vi.fn()} onAgentsChanged={vi.fn()} onModelConnectionsChanged={vi.fn()} firstRun={firstRun}/>);});
 if (!firstRun) await act(async () => {fireEvent.click(screen.getByText('New Agent'));});
 const next = () => fireEvent.click(screen.getByText('Next'));
 fireEvent.click(screen.getByText('Start fresh')); fireEvent.change(screen.getByPlaceholderText('Your name'),{target:{value:'Operator'}}); next();
 fireEvent.change(screen.getByPlaceholderText('Luna'),{target:{value:'Agent'}}); next(); next();
 fireEvent.change(screen.getAllByRole('combobox')[0],{target:{value:'p'}});
 expect(screen.getByRole('option',{name:'m'})).toBeTruthy();
 expect(screen.queryByRole('option',{name:'off'})).toBeNull();
 fireEvent.change(screen.getAllByRole('combobox')[1],{target:{value:'m'}});
 await act(async () => {fireEvent.click(screen.getByText('Skip / Finish'));});
 expect(screen.getByText('You magnificent thing.')).toBeTruthy();
 const write = vi.mocked(api).mock.calls.find(([path, options]) => path === '/api/agents/agent/model-selection' && options?.method === 'PUT');
 expect(write).toBeTruthy();
 expect(JSON.parse(String(write![1]!.body))).toEqual({connectionId:'p',model:'m'});

});
