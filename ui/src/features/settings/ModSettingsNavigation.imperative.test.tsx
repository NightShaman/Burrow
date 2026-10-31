import { useState, type ComponentProps } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ConfirmProvider } from '../../app/ConfirmDialog';
import { UnsavedChangesProvider, type UnsavedDraft } from '../../app/UnsavedChanges';
import { api } from '../../app/api';
import type { SettingsTab } from '../../app/types';
import { Settings } from './SettingsPage';

vi.mock('../../app/api', async original => ({ ...await original<typeof import('../../app/api')>(), api: vi.fn() }));
vi.mock('../../app/apiTargets', () => ({
  loadModSettingsContributions: async () => [{ modId: 'fixture', name: 'Fixture mod', settingsUrl: './ModSettingsImperativeFixture', settings: [
    { id: 'one', navigation: { title: 'One' }, primary: { title: 'One', capability: 'settingsUi' } },
    { id: 'two', navigation: { title: 'Two' }, primary: { title: 'Two', capability: 'settingsUi' } },
  ] }], modContributionsChangedEvent: 'mods-changed',
}));
vi.mock('./SystemStatsRail', () => ({ SystemStatsRail: () => null }));
afterEach(() => { cleanup(); vi.resetAllMocks(); Reflect.deleteProperty(globalThis, '__modSettingsTestMount'); });

it('protects a real mod subsection and category boundary in Settings via the same registration', async () => {
  vi.mocked(api).mockImplementation(async path => {
    if (path === '/api/settings/identities') return { operator: { name: 'Operator', avatar: '' } };
    if (path === '/api/settings/browser-tab') return { suffix: '' };
    if (path === '/api/settings/timezone') return { timezone: 'UTC' };
    return { wizardStep: 'ready' };
  });
  const discard = vi.fn();
  Object.assign(globalThis, { __modSettingsTestMount: (ctx: { section: string; primary: { replace: (node: Node) => void }; setDraft: (draft: UnsavedDraft | null) => void }) => {
    const section = document.createElement('section'); section.className = 'setting-section'; section.innerHTML = `<h2>Mod ${ctx.section}</h2><input aria-label="Mod draft" value="saved">`;
    const input = section.querySelector('input')!;
    const publish = () => ctx.setDraft({ dirty: input.value !== 'saved', busy: false, save: async () => false, discard: () => { discard(); input.value = 'saved'; publish(); } });
    input.addEventListener('input', publish); ctx.primary.replace(section); publish();
  } });
  const top = document.createElement('div'); document.body.append(top);
  function Parent() {
    const [tab, setTab] = useState<SettingsTab>('general');
    return <Settings {...{ navigationTarget: top, tab, setTab, agents: [], selected: { id: '', name: '' }, savedProviders: [], onOperatorProfileChanged: vi.fn(), agentRailPreferences: { view: 'regular', order: [] } } as unknown as ComponentProps<typeof Settings>} />;
  }
  const view = render(<ConfirmProvider><UnsavedChangesProvider><Parent /></UnsavedChangesProvider></ConfirmProvider>);
  fireEvent.click(await within(top).findByRole('button', { name: 'Fixture mod' }));
  const input = await screen.findByLabelText('Mod draft');
  fireEvent.input(input, { target: { value: 'changed' } });
  fireEvent.click(screen.getByRole('button', { name: 'One' })); expect(screen.queryByRole('alertdialog')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Two' }));
  expect(screen.getByRole('alertdialog', { name: 'Unsaved changes' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Stay' }));
  expect(screen.getByRole('heading', { name: 'Mod one' })).toBeTruthy();
  fireEvent.click(within(top).getByRole('button', { name: 'General' }));
  expect(screen.getByRole('alertdialog', { name: 'Unsaved changes' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
  await screen.findByRole('heading', { name: 'Operator profile' });
  expect(discard).toHaveBeenCalledOnce();
  await act(async () => {}); await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  view.unmount(); top.remove();
});
