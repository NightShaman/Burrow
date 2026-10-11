import { useState, type ComponentProps } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Settings } from './SettingsPage';
import { ConfirmProvider } from '../../app/ConfirmDialog';
import { api } from '../../app/api';
import type { SettingsTab } from '../../app/types';
vi.mock('../../app/api', async original => ({ ...await original<typeof import('../../app/api')>(), api: vi.fn() }));
vi.mock('../../app/apiTargets', () => ({ loadModSettingsContributions: async () => [], modContributionsChangedEvent: 'mods-changed' }));
vi.mock('./SystemStatsRail', () => ({ SystemStatsRail: () => null }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
it('mounts only the selected configuration, with no hidden duplicate reads', async () => {
 vi.mocked(api).mockImplementation(async path => {
  if (path === '/api/settings/identities') return { operator: { name: 'Test', avatar: '' } };
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
 expect(vi.mocked(api).mock.calls.map(([path]) => path).sort()).toEqual(['/api/settings/identities', '/api/setup/status']);
 fireEvent.click(screen.getByRole('button', { name: /^Connections$/ }));
 await waitFor(() => expect(screen.getByRole('button', { name: 'Save authentication' }).hasAttribute('disabled')).toBe(false));
 expect(screen.getAllByRole('button', { name: 'Save authentication' })).toHaveLength(1);
 const paths = vi.mocked(api).mock.calls.map(([path]) => path);
 expect(paths.filter(path => path === '/api/settings/ui-auth')).toHaveLength(1);
 expect(paths).not.toContain('/api/settings/mcp-connections');
 expect(paths).not.toContain('/api/settings/model-connections');
});
it('shows agent options from active rail selections without focusing a dropdown', () => {
 vi.mocked(api).mockResolvedValue({ wizardStep: 'ready' });
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
 expect(screen.getByRole('region', { name: 'Skill library' }).classList.contains('settings-prototype-sections')).toBe(true);
 expect(screen.getByRole('region', { name: 'Skill details and assignments' }).classList.contains('settings-prototype-configuration')).toBe(true);
 expect(screen.getByRole('complementary', { name: 'Skill source and updates' }).classList.contains('settings-prototype-overflow')).toBe(true);
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

it('uses the top menu for General while retaining the three content columns', async () => {
 vi.mocked(api).mockImplementation(async path => path === '/api/settings/identities' ? { operator: { name: 'Test', avatar: '' } } : { wizardStep: 'ready' });
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
