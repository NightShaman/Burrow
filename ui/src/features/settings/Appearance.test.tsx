import { type ComponentProps } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../../app/api';
import { usePersistedTheme } from '../../app/usePersistedLayout';
import { Settings } from './SettingsPage';

vi.mock('../../app/api', async original => ({ ...await original<typeof import('../../app/api')>(), api: vi.fn() }));
vi.mock('../../app/apiTargets', async original => ({ ...await original<typeof import('../../app/apiTargets')>(), loadModSettingsContributions: async () => [] }));
vi.mock('./SystemStatsRail', () => ({ SystemStatsRail: () => null }));
afterEach(() => { cleanup(); localStorage.clear(); vi.resetAllMocks(); });

it('offers Halloween separately from Midnight and persists the selected palette without API writes', async () => {
  localStorage.setItem('hc.theme', JSON.stringify({ version: 1, value: 'midnight' }));
  vi.mocked(api).mockImplementation(async path => {
    if (path === '/api/settings/identities') return { operator: { name: 'Test', avatar: '' } };
    if (path === '/api/settings/browser-tab') return { suffix: '' };
    if (path === '/api/settings/timezone') return { timezone: 'America/Chicago' };
    return { wizardStep: 'ready' };
  });
  function Parent() {
    const [theme, setTheme] = usePersistedTheme();
    return <Settings {...{ tab: 'general', setTab: vi.fn(), agents: [], selected: { id: '', name: '' },
      savedProviders: [], onOperatorProfileChanged: vi.fn(), agentRailPreferences: { view: 'regular', order: [] },
      theme, setTheme } as unknown as ComponentProps<typeof Settings>} />;
  }
  render(<Parent />);
  await screen.findByDisplayValue('Test');
  fireEvent.click(screen.getByRole('button', { name: 'Appearance' }));
  const midnight = screen.getByRole('button', { name: /^Midnight/ });
  const halloween = screen.getByRole('button', { name: /^Halloween/ });
  expect(midnight.getAttribute('aria-pressed')).toBe('true');
  expect(halloween.getAttribute('aria-pressed')).toBe('false');
  fireEvent.click(halloween);
  expect(halloween.getAttribute('aria-pressed')).toBe('true');
  expect(midnight.getAttribute('aria-pressed')).toBe('false');
  await waitFor(() => expect(JSON.parse(localStorage.getItem('hc.theme') ?? '{}')).toEqual({ version: 1, value: 'halloween' }));
  fireEvent.click(midnight);
  expect(midnight.getAttribute('aria-pressed')).toBe('true');
  await waitFor(() => expect(JSON.parse(localStorage.getItem('hc.theme') ?? '{}')).toEqual({ version: 1, value: 'midnight' }));
  expect(vi.mocked(api).mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true);
});
