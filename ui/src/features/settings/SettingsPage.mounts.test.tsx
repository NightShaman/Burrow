import { useState, type ComponentProps } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Settings } from './SettingsPage';
import { ConfirmProvider } from '../../app/ConfirmDialog';
import { api } from '../../app/api';
import type { SettingsTab } from '../../app/types';
import type { ModContribution } from '../../app/apiTargets';
vi.mock('../../app/api', async original => ({ ...await original<typeof import('../../app/api')>(), api: vi.fn() }));
const { loadModSettingsContributions, mountModSettings } = vi.hoisted(() => ({ loadModSettingsContributions: vi.fn<() => Promise<ModContribution[]>>(async () => []), mountModSettings: vi.fn() }));
vi.mock('../../app/apiTargets', () => ({ loadModSettingsContributions, modContributionsChangedEvent: 'mods-changed' }));
vi.mock('./ModSettingsHostFixture', () => ({
 settingsSections: [
  { id: 'controller', label: 'Controller & TLS' },
  { id: 'pairings', label: 'Pending pairings' },
  { id: 'gateways', label: 'Gateways' },
  { id: 'assignments', label: 'Agent assignments' },
  { id: 'operations', label: 'Operation activity' },
 ],
 mountSettings: mountModSettings, settingsContribution: undefined, createSettingsContribution: undefined,
}));
vi.mock('./SystemStatsRail', () => ({ SystemStatsRail: () => null }));
afterEach(() => { cleanup(); vi.resetAllMocks(); loadModSettingsContributions.mockResolvedValue([]); });
it('mounts only the selected configuration, with no hidden duplicate reads', async () => {
 vi.mocked(api).mockImplementation(async path => {
  if (path === '/api/settings/identities') return { operator: { name: 'Test', avatar: '' } };
  if (path === '/api/settings/browser-tab') return { suffix: '' };
  if (path === '/api/settings/timezone') return { timezone: 'America/Chicago' };
  if (path === '/api/settings/ui-auth') return { auth: { mode: 'none' } };
  if (path === '/api/settings/browser-origin') return { settings: { checkOrigin: false }, effective: { checkOrigin: false, source: 'database' } };
  return { wizardStep: 'ready' };
 });
 function Parent() {
  const [tab, setTab] = useState<SettingsTab>('general');
  return <Settings {...{ tab, setTab, agents: [], selected: { id: '', name: '' }, savedProviders: [], onOperatorProfileChanged: vi.fn(), agentRailPreferences: { view: 'list', order: [] } } as unknown as ComponentProps<typeof Settings>} />;
 }
 const { container } = render(<Parent />);
 await screen.findByDisplayValue('Test');
 expect(container.querySelector('.settings-baseline-hidden')).toBeNull();
 const profile = screen.getByRole('heading', { name: 'Operator profile' }).closest('.setting-section');
 const timezone = screen.getByRole('heading', { name: 'Operator timezone' }).closest('.setting-section');
 expect(profile?.parentElement?.classList.contains('settings-prototype-configuration')).toBe(true);
 expect(profile?.nextElementSibling?.tagName).toBe('HR');
 expect(profile?.nextElementSibling?.nextElementSibling).toBe(timezone);
 expect(screen.queryByRole('button', { name: 'Operator timezone' })).toBeNull();
 expect(screen.getByRole('heading', { name: 'Browser tab' }).closest('.settings-prototype-overflow')).toBeTruthy();
 expect(screen.queryByRole('button', { name: 'Browser tab' })).toBeNull();
 fireEvent.click(screen.getByRole('button', { name: 'Continuity' }));
 expect(screen.getByRole('heading', { name: 'Continuity' }).closest('.settings-prototype-configuration')).toBeTruthy();
 expect(screen.getByRole('heading', { name: 'Tiddle Signal' }).closest('.settings-prototype-overflow')).toBeTruthy();
 expect(screen.queryByRole('button', { name: 'Tiddle Signal' })).toBeNull();
 fireEvent.click(screen.getByRole('button', { name: 'Operator profile' }));
 await screen.findByDisplayValue('America/Chicago');
 fireEvent.click(screen.getByRole('button', { name: /^Connections$/ }));
 await waitFor(() => expect(screen.getByRole('button', { name: 'Save authentication' }).hasAttribute('disabled')).toBe(false));
 expect(screen.getAllByRole('button', { name: 'Save authentication' })).toHaveLength(1);
 const paths = vi.mocked(api).mock.calls.map(([path]) => path);
 expect(paths.filter(path => path === '/api/settings/ui-auth')).toHaveLength(1);
 expect(paths).not.toContain('/api/settings/mcp-connections');
 expect(paths).not.toContain('/api/settings/model-connections');
 expect(paths).not.toContain('/api/settings/browser-origin');
 expect(screen.queryByRole('button', { name: 'Save browser origin' })).toBeNull();
 const originButton = screen.getByRole('button', { name: 'Browser origin' });
 expect(originButton.closest('.settings-prototype-sections')).toBeTruthy();
 fireEvent.click(originButton);
 await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Check browser origin' }).hasAttribute('disabled')).toBe(false));
 expect(originButton.getAttribute('aria-current')).toBe('page');
 expect(screen.getByRole('heading', { name: 'Browser origin' }).closest('.settings-prototype-configuration')).toBeTruthy();
 expect(screen.queryByRole('button', { name: 'Save authentication' })).toBeNull();
 expect(vi.mocked(api).mock.calls.filter(([path]) => path === '/api/settings/browser-origin')).toHaveLength(1);
 fireEvent.click(screen.getByRole('button', { name: /^Authentication$/ }));
 await screen.findByRole('button', { name: 'Save authentication' });
 expect(screen.queryByRole('button', { name: 'Save browser origin' })).toBeNull();
});
it('shows agent options from active rail selections without focusing a dropdown', () => {
 vi.mocked(api).mockImplementation(async path => path === '/api/settings/browser-tab' ? { suffix: '' } : path === '/api/settings/timezone' ? { timezone: 'America/Chicago' } : { wizardStep: 'ready' });
 function Parent() {
  const [leftSinglePanel, setLeftSinglePanel] = useState<'agents' | 'workspace'>('agents');
  const [leftRailLayout, setLeftRailLayout] = useState<'single' | 'divided'>('single');
  return <Settings {...{ tab: 'general', setTab: vi.fn(), agents: [], selected: { id: '', name: '' }, savedProviders: [], onOperatorProfileChanged: vi.fn(), agentRailPreferences: { view: 'regular', order: [] }, setAgentRailPreferences: vi.fn(), leftSinglePanel, setLeftSinglePanel, leftRailLayout, setLeftRailLayout, leftTopPanel: 'agents', leftBottomPanel: 'workspace', rightRailLayout: 'single', rightSinglePanel: 'workspace', rightTopPanel: 'agents', rightBottomPanel: 'workspace' } as unknown as ComponentProps<typeof Settings>} />;
 }
 render(<Parent />);
 fireEvent.click(screen.getByRole('button', { name: 'Rail panels' }));
 expect(screen.getByText('Agent panel options')).toBeTruthy();
 fireEvent.focus(screen.getByLabelText('Right · panel'));
 expect(screen.getByText('Agent panel options')).toBeTruthy();
 fireEvent.change(screen.getByLabelText('Left · panel'), { target: { value: 'workspace' } });
 expect(screen.queryByText('Agent panel options')).toBeNull();
 fireEvent.change(screen.getByLabelText('Left · layout'), { target: { value: 'divided' } });
 expect(screen.getByText('Agent panel options')).toBeTruthy();
});

it('places Skills navigation in the supplied card without duplicating it in the workspace', async () => {
 vi.mocked(api).mockImplementation(async path => {
  if (path === '/api/settings/skills') return { skills: [] };
  if (path.includes('/skills')) return { skills: [] };
  return { wizardStep: 'ready' };
 });
 const navigationTarget = document.createElement('div');
 document.body.append(navigationTarget);
 const { container, unmount } = render(<ConfirmProvider><Settings {...{ navigationTarget, tab: 'skills', setTab: vi.fn(), agents: [], selected: { id: '', name: '' }, savedProviders: [], onOperatorProfileChanged: vi.fn(), agentRailPreferences: { view: 'regular', order: [] } } as unknown as ComponentProps<typeof Settings>} /></ConfirmProvider>);
 expect(navigationTarget.querySelector('nav[aria-label="Settings sections"]')).not.toBeNull();
 expect(container.querySelector('nav[aria-label="Settings sections"]')).toBeNull();
 expect(screen.getAllByRole('navigation', { name: 'Settings sections' })).toHaveLength(1);
 const layout = container.querySelector('.settings-blank-slate.has-top-navigation');
 expect(layout?.querySelectorAll(':scope > .settings-blank-column')).toHaveLength(3);
 expect(container.querySelector('.skills-settings-workspace')).toBeNull();
 expect(screen.getByRole('navigation', { name: 'Skills settings sections' }).closest('.settings-prototype-sections')).toBeTruthy();
 expect((await screen.findByRole('heading', { name: 'Installed skills' })).closest('.settings-prototype-configuration')).toBeTruthy();
 expect(screen.getByRole('region', { name: 'Additional settings' }).classList.contains('settings-prototype-overflow')).toBe(true);
 expect(screen.getByRole('searchbox', { name: 'Search skills' }).closest('.settings-prototype-overflow')).toBeTruthy();
 fireEvent.click(screen.getByRole('button', { name: 'Import from repository' }));
 await screen.findByRole('button', { name: 'Preview skill' });
 expect(screen.getByLabelText('Repository').closest('.settings-prototype-configuration')).toBeTruthy();
 expect(screen.queryByText('Sync history')).toBeNull();
 expect(screen.queryByLabelText('Search skills')).toBeNull();
 fireEvent.click(screen.getByRole('button', { name: 'New text skill' }));
 await screen.findByRole('button', { name: 'Create skill' });
 expect(screen.queryByLabelText('Search skills')).toBeNull();
 fireEvent.click(screen.getByRole('button', { name: 'Installed skills' }));
 expect(screen.getByLabelText('Search skills')).toBeTruthy();
 fireEvent.click(screen.getByRole('button', { name: 'Open system statistics' }));
 expect(layout?.classList.contains('has-utility-panel')).toBe(true);
 expect(screen.getByRole('complementary', { name: 'System statistics' })).toBeTruthy();
 fireEvent.click(screen.getByRole('button', { name: 'Collapse system statistics' }));
 expect(layout?.classList.contains('has-utility-panel')).toBe(false);
 await waitFor(() => expect(vi.mocked(api)).toHaveBeenCalled());
 unmount();
 expect(navigationTarget.childElementCount).toBe(0);
 navigationTarget.remove();
});

it('groups a mod settings contributions under one top-level tab and exposes secondary sections', async () => {
 loadModSettingsContributions.mockResolvedValue([{
  modId: 'burrow-switchboard',
  name: 'Switchboard',
  settings: [
   { id: 'status', navigation: { title: 'Status' }, primary: { title: 'Status', capability: 'settingsUi' } },
   { id: 'configuration', navigation: { title: 'Configuration' }, primary: { title: 'Configuration', capability: 'settingsUi' } },
   { id: 'pending-admissions', navigation: { title: 'Pending admissions' }, primary: { title: 'Pending admissions', capability: 'settingsUi' } },
   { id: 'chat-mappings', navigation: { title: 'Chat mappings' }, primary: { title: 'Chat mappings', capability: 'settingsUi' } },
  ],
 }]);
 vi.mocked(api).mockImplementation(async path => path === '/api/settings/browser-tab' ? { suffix: '' } : path === '/api/settings/timezone' ? { timezone: 'America/Chicago' } : { wizardStep: 'ready' });
 function Parent() {
  const [tab, setTab] = useState<SettingsTab>('general');
  return <Settings {...{ tab, setTab, agents: [], selected: { id: '', name: '' }, savedProviders: [], onOperatorProfileChanged: vi.fn(), agentRailPreferences: { view: 'regular', order: [] } } as unknown as ComponentProps<typeof Settings>} />;
 }
 render(<Parent />);
 const switchboard = await screen.findByRole('button', { name: 'Switchboard' });
 expect(screen.getAllByRole('button', { name: 'Switchboard' })).toHaveLength(1);
 fireEvent.click(switchboard);
 const secondary = screen.getByRole('navigation', { name: 'Switchboard settings sections' });
 for (const name of ['Status', 'Configuration', 'Pending admissions', 'Chat mappings']) expect(secondary.querySelector(`button:nth-child(${['Status', 'Configuration', 'Pending admissions', 'Chat mappings'].indexOf(name) + 1})`)?.textContent).toBe(name);
 expect(screen.getByRole('button', { name: 'Status' }).getAttribute('aria-current')).toBe('page');
 fireEvent.click(screen.getByRole('button', { name: 'Chat mappings' }));
 expect(screen.getByRole('button', { name: 'Chat mappings' }).getAttribute('aria-current')).toBe('page');
 expect(screen.getByRole('button', { name: 'Switchboard' }).getAttribute('aria-current')).toBe('page');
 fireEvent.click(screen.getByRole('button', { name: 'General' }));
 fireEvent.click(screen.getByRole('button', { name: 'Switchboard' }));
 expect(screen.getByRole('button', { name: 'Status' }).getAttribute('aria-current')).toBe('page');
});

it('uses dynamic mod sections when manifest metadata is only a top-level contribution', async () => {
 loadModSettingsContributions.mockResolvedValue([{
  modId: 'node-goblin',
  name: 'Node Goblin',
  settingsUrl: './ModSettingsHostFixture',
  settings: [{ id: 'node-goblin', navigation: { title: 'Node Goblin' }, primary: { title: 'Node Goblin', capability: 'settingsUi' } }],
 }]);
 mountModSettings.mockImplementation(({ section, primary }: { section: string; primary: { replace: (node: Node) => void } }) => {
  const node = document.createElement('span'); node.textContent = `Mounted ${section}`; primary.replace(node);
 });
 vi.mocked(api).mockImplementation(async path => path === '/api/settings/browser-tab' ? { suffix: '' } : path === '/api/settings/timezone' ? { timezone: 'America/Chicago' } : { wizardStep: 'ready' });
 function Parent() {
  const [tab, setTab] = useState<SettingsTab>('general');
  return <Settings {...{ tab, setTab, agents: [], selected: { id: '', name: '' }, savedProviders: [], onOperatorProfileChanged: vi.fn(), agentRailPreferences: { view: 'regular', order: [] } } as unknown as ComponentProps<typeof Settings>} />;
 }
 render(<ConfirmProvider><Parent /></ConfirmProvider>);
 fireEvent.click(await screen.findByRole('button', { name: 'Node Goblin' }));
 const secondary = await screen.findByRole('navigation', { name: 'node-goblin settings sections' });
 await waitFor(() => expect(Array.from(secondary.querySelectorAll('button'), (button) => button.textContent)).toEqual(['Controller & TLS', 'Pending pairings', 'Gateways', 'Agent assignments', 'Operation activity']));
 expect(await screen.findByText('Mounted controller')).toBeTruthy();
 fireEvent.click(screen.getByRole('button', { name: 'Gateways' }));
 expect(await screen.findByText('Mounted gateways')).toBeTruthy();
});

it('uses the top menu for General while retaining the three content columns', async () => {
 vi.mocked(api).mockImplementation(async path => path === '/api/settings/browser-tab' ? { suffix: '' } : path === '/api/settings/identities' ? { operator: { name: 'Test', avatar: '' } } : path === '/api/settings/timezone' ? { timezone: 'America/Chicago' } : { wizardStep: 'ready' });
 const navigationTarget = document.createElement('div');
 document.body.append(navigationTarget);
 const { container, unmount } = render(<Settings {...{ navigationTarget, tab: 'general', setTab: vi.fn(), agents: [], selected: { id: '', name: '' }, savedProviders: [], onOperatorProfileChanged: vi.fn(), agentRailPreferences: { view: 'regular', order: [] } } as unknown as ComponentProps<typeof Settings>} />);
 await screen.findByDisplayValue('Test');
 expect(navigationTarget.querySelector('nav[aria-label="Settings sections"]')).not.toBeNull();
 expect(container.querySelector('.settings-prototype-menu')).toBeNull();
 const layout = container.querySelector('.settings-blank-slate.has-top-navigation');
 expect(layout).not.toBeNull();
 expect(layout?.querySelectorAll(':scope > .settings-blank-column')).toHaveLength(3);
 expect(container.querySelector('.settings-prototype-sections')).not.toBeNull();
 expect(container.querySelector('.settings-prototype-configuration')).not.toBeNull();
 expect(container.querySelector('.settings-prototype-overflow')).not.toBeNull();
 unmount();
 expect(navigationTarget.childElementCount).toBe(0);
 navigationTarget.remove();
});


it('navigates between separate Models and Load Balancing editors without leaking identity', async () => {
 vi.mocked(api).mockImplementation(async path => path === '/api/settings/browser-tab' ? { suffix: '' } : path === '/api/settings/timezone' ? { timezone: 'America/Chicago' } : { wizardStep: 'ready' });
 render(<ConfirmProvider><Settings {...{ tab: 'connections', setTab: vi.fn(), agents: [], selected: { id: '', name: '' }, savedProviders: [], onModelConnectionsChanged: vi.fn(), agentRailPreferences: { view: 'regular', order: [] } } as unknown as ComponentProps<typeof Settings>} /></ConfirmProvider>);
 fireEvent.click(screen.getByRole('button', { name: 'Models' }));
 expect(screen.getByRole('heading', { name: 'Models' })).toBeTruthy();
 fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'Direct draft' } });
 fireEvent.click(screen.getByRole('button', { name: 'Load Balancing' }));
 expect(screen.getByRole('heading', { name: 'Load Balancing' })).toBeTruthy();
 expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('OpenAI LB');
 expect(screen.queryByLabelText('API type')).toBeNull();
 expect(screen.queryByLabelText('URL')).toBeNull();
 fireEvent.click(screen.getByRole('button', { name: 'Models' }));
 expect((screen.getByLabelText('Provider') as HTMLInputElement).value).toBe('');
 expect((screen.getByLabelText('API type') as HTMLSelectElement).value).toBe('openai-chat-completions');
 await waitFor(() => expect(vi.mocked(api)).toHaveBeenCalled());
});
