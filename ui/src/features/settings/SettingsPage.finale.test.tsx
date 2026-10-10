import { useState, type ComponentProps } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Settings } from './SettingsPage';
import { api } from '../../app/api';
import type { Agent } from '../../app/types';
vi.mock('../../app/api', async original => ({ ...await original<typeof import('../../app/api')>(), api: vi.fn() }));
vi.mock('../../app/apiTargets', async original => ({ ...await original<typeof import('../../app/apiTargets')>(), loadModSettingsContributions: async () => [] }));
vi.mock('./AgentSettings', () => ({ AgentSettings: () => null }));
vi.mock('./SystemStatsRail', () => ({ SystemStatsRail: () => null }));
afterEach(() => { cleanup(); localStorage.clear(); vi.useRealTimers(); vi.resetAllMocks(); });

it.each(['skip', 'provider'])('keeps one finale mounted across Settings parent updates (%s)', async mode => {
 vi.useFakeTimers();
 const provider = { id: 'openai-main', provider: 'OpenAI', apiType: 'openai-responses', baseUrl: 'https://example.test', models: ['gpt-test'] };
 vi.mocked(api).mockImplementation(async path => {
  if (path === '/api/setup/status') return { wizardStep: 'fresh' };
  if (path === '/api/setup/complete') return { wizardStep: 'ready', configured: true };
  if (path === '/api/setup/operation') return { agent: { id: 'luna' } };
  return { connections: [provider] };
 });
 const complete = vi.fn();
 const agent = { id: 'luna', name: 'Luna', subagents: [], files: [] } as unknown as Agent;
 function Parent() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [profile, setProfile] = useState('');
  const [done, setDone] = useState(false);
  const props = { tab: 'agents', setTab: vi.fn(), agents, selected: agents[0] ?? { ...agent, id: '' }, savedProviders: [],
   onAgentsChanged: async () => { setAgents([agent]); }, onModelConnectionsChanged: async () => {},
   onOperatorProfileChanged: (value: { name: string }) => setProfile(value.name),
   onFirstRunComplete: () => { complete(); setDone(true); }, agentRailPreferences: { view: 'list', order: [] },
  } as unknown as ComponentProps<typeof Settings>;
  return done ? <p>Chat entered</p> : <><span>{profile}</span><Settings {...props} /></>;
 }
 await act(async () => { render(<Parent />); });
 // The hidden baseline must not own another auto-opening wizard/timer.
 expect(screen.getAllByRole('dialog')).toHaveLength(1);
 fireEvent.click(screen.getByText('Start fresh'));
 fireEvent.change(screen.getByPlaceholderText('Your name'), { target: { value: 'Operator' } });
 fireEvent.click(screen.getByText('Next'));
 fireEvent.change(screen.getByPlaceholderText('Luna'), { target: { value: 'Luna' } });
 fireEvent.click(screen.getByText('Next')); fireEvent.click(screen.getByText('Next'));
 if (mode === 'provider') {
  fireEvent.change(screen.getByLabelText('Provider'), { target: { value: provider.id } });
  fireEvent.change(screen.getByLabelText('Model'), { target: { value: provider.models[0] } });
 }
 await act(async () => { fireEvent.click(screen.getByText('Skip / Finish')); });
 expect(vi.mocked(api).mock.calls.filter(([path]) => path === '/api/setup/complete')).toHaveLength(1);
 expect(screen.getAllByText('You magnificent thing.')).toHaveLength(1);
 expect(complete).not.toHaveBeenCalled();
 await act(async () => { vi.advanceTimersByTime(4999); });
 expect(screen.getByText('Entering Burrow…')).toBeTruthy();
 expect(complete).not.toHaveBeenCalled();
 await act(async () => { vi.advanceTimersByTime(1); });
 expect(complete).toHaveBeenCalledTimes(1);
 expect(screen.getByText('Chat entered')).toBeTruthy();
 expect(screen.queryByText('Start fresh')).toBeNull();
});
