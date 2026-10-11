import { useState, type ComponentProps } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Settings } from './SettingsPage';
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
