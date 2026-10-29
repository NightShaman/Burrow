import { useState, type ComponentProps } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api } from '../../app/api';
import { ConfirmProvider } from '../../app/ConfirmDialog';
import { UnsavedChangesProvider } from '../../app/UnsavedChanges';
import type { SettingsTab } from '../../app/types';
import { Settings } from './SettingsPage';

vi.mock('../../app/api', async original => ({ ...await original<typeof import('../../app/api')>(), api: vi.fn() }));
vi.mock('../../app/apiTargets', () => ({ loadModSettingsContributions: vi.fn(async () => []), modContributionsChangedEvent: 'mods-changed' }));
vi.mock('./SystemStatsRail', () => ({ SystemStatsRail: () => null }));

const profile = { name: 'Operator', avatar: '' };
const alpha = { id: 'alpha', name: 'Alpha', transport: 'http', lifecycle: 'ephemeral', baseUrl: 'https://alpha.test', command: null, args: [], enabled: true, apiKeyConfigured: true, environmentVariables: [], tools: [] };
const onProfileSaved = vi.fn();
const portalTargets: HTMLElement[] = [];

beforeEach(() => {
  localStorage.clear();
  vi.mocked(api).mockImplementation(async (path, options) => {
    if (options?.method === 'PUT' || options?.method === 'POST') return { ok: true };
    if (path === '/api/mod-management') return { mods: [], sources: [] };
    if (path === '/api/mod-management/source-refresh') return { sourceRefresh: { enabled: false, intervalMs: 3_600_000, staleMs: 60_000 } };
    if (path.startsWith('/api/mod-management/secret-references')) return { references: [] };
    if (path === '/api/setup/status') return { wizardStep: 'ready' };
    if (path === '/api/settings/identities') return { operator: profile };
    if (path === '/api/settings/mcp-connections') return { connections: [alpha] };
    if (path === '/api/settings/ui-auth') return { auth: { mode: 'none' } };
    if (path === '/api/settings/browser-origin') return { settings: { checkOrigin: false }, effective: { checkOrigin: false, source: 'database' } };
    throw new Error(`Unexpected settings read: ${path}`);
  });
});
afterEach(() => {
  cleanup();
  portalTargets.splice(0).forEach(target => target.remove());
  vi.clearAllMocks();
  vi.mocked(api).mockReset();
});

function mount(form: 'profile' | 'MCP' | 'Mods', portal = false) {
  const navigationTarget = portal ? document.createElement('div') : undefined;
  if (navigationTarget) { document.body.append(navigationTarget); portalTargets.push(navigationTarget); }
  function Parent() {
    const [tab, setTab] = useState<SettingsTab>(form === 'profile' ? 'general' : form === 'Mods' ? 'mods' : 'connections');
    return <Settings {...{ navigationTarget, tab, setTab, agents: [], selected: { id: '', name: '' }, savedProviders: [], onOperatorProfileChanged: onProfileSaved, agentRailPreferences: { view: 'regular', order: [] } } as unknown as ComponentProps<typeof Settings>} />;
  }
  const result = render(<ConfirmProvider><UnsavedChangesProvider><Parent /></UnsavedChangesProvider></ConfirmProvider>);
  if (navigationTarget) {
    expect(within(navigationTarget).getByRole('navigation', { name: 'Settings sections' })).toBeTruthy();
    expect(result.container.querySelector('nav[aria-label="Settings sections"]')).toBeNull();
  }
  return navigationTarget;
}
const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }));
const mutations = () => vi.mocked(api).mock.calls.filter(([, options]) => options?.method === 'PUT' || options?.method === 'POST');
function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
async function dirty(form: 'profile' | 'MCP') {
  if (form === 'profile') {
    await screen.findByDisplayValue('Operator');
    const input = screen.getByLabelText('Displayed name');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'Profile draft' } });
  } else {
    click('MCP servers');
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Alpha' }));
    expect(screen.getByRole('button', { name: 'Edit Alpha' }).closest('[aria-label="Additional settings"]')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'MCP draft' } });
  }
}
const destinations = {
  profile: { subsection: { button: 'Appearance', heading: 'Appearance' }, category: { button: 'Connections', heading: 'Authentication' } },
  MCP: { subsection: { button: 'Browser origin', heading: 'Browser origin' }, category: { button: 'General', heading: 'Operator profile' } },
} as const;
const cases = (['profile', 'MCP'] as const).flatMap(form => (['subsection', 'category'] as const).flatMap(kind => (['Stay', 'Discard', 'Save'] as const).map(choice => ({ form, kind, choice }))));

it.each(cases)('$form dirty navigation to $kind: $choice preserves or reaches the requested destination', async ({ form, kind, choice }) => {
  const target = mount(form, kind === 'category');
  await dirty(form);
  const destination = destinations[form][kind];
  const originalCategory = form === 'profile' ? 'General' : 'Connections';
  const originalSection = form === 'profile' ? 'Operator profile' : 'MCP servers';
  if (target) fireEvent.click(within(target).getByRole('button', { name: destination.button }));
  else click(destination.button);

  const dialog = screen.getByRole('alertdialog', { name: 'Unsaved changes' });
  expect(screen.getByDisplayValue(`${form === 'profile' ? 'Profile' : 'MCP'} draft`)).toBeTruthy();
  expect(screen.getByRole('button', { name: originalCategory }).getAttribute('aria-current')).toBe('page');
  expect(screen.getByRole('button', { name: originalSection }).getAttribute('aria-current')).toBe('page');
  expect(screen.queryByRole('heading', { name: destination.heading })).toBeNull();
  expect(mutations()).toHaveLength(0);

  if (choice === 'Stay') {
    fireEvent.click(within(dialog).getByRole('button', { name: 'Stay' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByDisplayValue(`${form === 'profile' ? 'Profile' : 'MCP'} draft`)).toBeTruthy();
    expect(screen.getByRole('button', { name: originalSection }).getAttribute('aria-current')).toBe('page');
    // A new request must replace, not accidentally resume, the cancelled destination.
    const other = destinations[form][kind === 'category' ? 'subsection' : 'category'];
    click(other.button);
    click('Discard');
    await screen.findByRole('heading', { name: other.heading });
    expect(screen.queryByRole('heading', { name: destination.heading })).toBeNull();
    expect(mutations()).toHaveLength(0);
  } else if (choice === 'Discard') {
    fireEvent.click(within(dialog).getByRole('button', { name: 'Discard' }));
    await screen.findByRole('heading', { name: destination.heading });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(mutations()).toHaveLength(0);
    // Returning mounts the saved baseline, not the discarded in-memory draft.
    if (kind === 'category') click(originalCategory);
    click(originalSection);
    if (form === 'profile') await screen.findByDisplayValue('Operator');
    else { fireEvent.click(await screen.findByRole('button', { name: 'Edit Alpha' })); expect(screen.getByDisplayValue('Alpha')).toBeTruthy(); }
  } else {
    const write = deferred();
    const refresh = deferred();
    const normalApi = vi.mocked(api).getMockImplementation()!;
    let written = false;
    vi.mocked(api).mockImplementation((path, options) => {
      if (options?.method === 'PUT' || options?.method === 'POST') { written = true; return write.promise as ReturnType<typeof api>; }
      if (form === 'MCP' && written && path === '/api/settings/mcp-connections') return refresh.promise as ReturnType<typeof api>;
      return normalApi(path, options);
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(screen.queryByRole('heading', { name: destination.heading })).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Discard' })).toHaveProperty('disabled', true);
    expect(mutations()).toHaveLength(1);
    const [path, options] = mutations()[0];
    expect(path).toBe(form === 'profile' ? '/api/settings/identities' : '/api/settings/mcp-connections');
    expect(options?.method).toBe(form === 'profile' ? 'PUT' : 'POST');
    expect(JSON.parse(String(options?.body))).toMatchObject(form === 'profile' ? { kind: 'operator', id: 'default', name: 'Profile draft' } : { id: 'alpha', name: 'MCP draft', baseUrl: alpha.baseUrl });
    await act(async () => write.resolve(form === 'profile' ? { ok: true, operator: { ...profile, name: 'Profile draft' } } : { ok: true }));
    if (form === 'MCP') {
      expect(screen.getByRole('alertdialog')).toBeTruthy();
      expect(screen.queryByRole('heading', { name: destination.heading })).toBeNull();
      await act(async () => refresh.resolve({ connections: [{ ...alpha, name: 'MCP draft' }] }));
    } else expect(onProfileSaved).toHaveBeenCalledWith({ name: 'Profile draft', avatar: '' });
    await screen.findByRole('heading', { name: destination.heading });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(mutations()).toHaveLength(1);
  }
});

it.each(['profile', 'MCP'] as const)('%s same subsection and same category (portal) preserve dirty drafts without prompting', async form => {
  const target = mount(form, true)!;
  await dirty(form);
  click(form === 'profile' ? 'Operator profile' : 'MCP servers');
  fireEvent.click(within(target).getByRole('button', { name: form === 'profile' ? 'General' : 'Connections' }));
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(screen.getByDisplayValue(`${form === 'profile' ? 'Profile' : 'MCP'} draft`)).toBeTruthy();
  expect(mutations()).toHaveLength(0);
});

// fireEvent.click alone does not transfer focus in jsdom: use the browser's
// mousedown -> focus/blur -> mouseup -> click ordering at navigation boundaries.
function clickWithFocus(button: HTMLElement) {
  fireEvent.pointerDown(button);
  fireEvent.mouseDown(button);
  act(() => button.focus());
  fireEvent.pointerUp(button);
  fireEvent.mouseUp(button);
  fireEvent.click(button);
}
async function focusDraft(form: 'profile' | 'Mods') {
  if (form === 'Mods') click('Automatic source checks');
  const input = form === 'profile'
    ? await screen.findByDisplayValue('Operator')
    : await screen.findByLabelText('Check every');
  act(() => input.focus());
  expect(document.activeElement).toBe(input);
  fireEvent.change(input, { target: { value: form === 'profile' ? 'Blur draft' : '2' } });
  return input;
}
const blurCases = (['profile', 'Mods'] as const).flatMap(form => (['subsection', 'category'] as const).map(kind => ({ form, kind })));
function blurDestination(form: 'profile' | 'Mods', kind: 'subsection' | 'category') {
  return kind === 'category' ? { button: 'Connections', heading: 'Authentication' }
    : form === 'profile' ? { button: 'Appearance', heading: 'Appearance' }
      : { button: 'Mod sources', heading: 'Mod sources' };
}
function deferMutation() {
  const write = deferred();
  const normalApi = vi.mocked(api).getMockImplementation()!;
  vi.mocked(api).mockImplementation((path, options) => options?.method === 'PUT'
    ? write.promise as ReturnType<typeof api> : normalApi(path, options));
  return write;
}
it.each(blurCases)('$form first $kind navigation waits for blur autosave then reaches the original destination exactly once', async ({ form, kind }) => {
  mount(form, kind === 'category');
  await focusDraft(form);
  const write = deferMutation();
  const destination = blurDestination(form, kind);
  clickWithFocus(screen.getByRole('button', { name: destination.button }));
  expect(mutations()).toHaveLength(1);
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(screen.queryByRole('heading', { name: destination.heading })).toBeNull();
  // Repeated or competing requests must not duplicate the write or replace the
  // first destination while the blur save is still in flight.
  clickWithFocus(screen.getByRole('button', { name: 'Skills' }));
  expect(mutations()).toHaveLength(1);
  await act(async () => write.resolve(form === 'profile' ? { ok: true, operator: { ...profile, name: 'Blur draft' } }
    : { sourceRefresh: { enabled: false, intervalMs: 7_200_000, staleMs: 60_000 } }));
  await screen.findByRole('heading', { name: destination.heading });
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(mutations()).toHaveLength(1);
  if (form === 'profile') expect(onProfileSaved).toHaveBeenCalledOnce();
});
it.each(blurCases)('$form failed blur autosave keeps the draft and guards the original $kind destination without a second write', async ({ form, kind }) => {
  mount(form, kind === 'category');
  const input = await focusDraft(form);
  const write = deferMutation();
  const destination = blurDestination(form, kind);
  clickWithFocus(screen.getByRole('button', { name: destination.button }));
  await act(async () => {
    if (form === 'profile') write.reject(new Error('offline'));
    else write.resolve({});
  });
  const dialog = await screen.findByRole('alertdialog', { name: 'Unsaved changes' });
  expect(screen.getAllByRole('alert').some(alert => /offline|invalid saved/.test(alert.textContent ?? ''))).toBe(true);
  expect(input).toHaveProperty('value', form === 'profile' ? 'Blur draft' : '2');
  expect(screen.queryByRole('heading', { name: destination.heading })).toBeNull();
  expect(mutations()).toHaveLength(1);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Stay' }));
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(input).toHaveProperty('value', form === 'profile' ? 'Blur draft' : '2');
  // Stay cancels the queued destination; the remaining failed draft still
  // guards a new request, and Discard never sends a retry mutation.
  click('Skills');
  click('Discard');
  await screen.findByRole('button', { name: 'Installed skills' });
  expect(screen.queryByRole('heading', { name: destination.heading })).toBeNull();
  expect(mutations()).toHaveLength(1);
});
it('Mods subsection validation failure supports Stay, Save retry and Discard through the shared guard', async () => {
  mount('Mods');
  const input = await focusDraft('Mods');
  fireEvent.change(input, { target: { value: '0' } });
  clickWithFocus(screen.getByRole('button', { name: 'Mod sources' }));
  expect(screen.getByRole('alertdialog')).toBeTruthy();
  expect(mutations()).toHaveLength(0);
  click('Stay');
  expect(input).toHaveProperty('value', '0');
  fireEvent.change(input, { target: { value: '2' } });
  // Focus is on the navigation button, so this tests explicit modal Save,
  // not another blur autosave.
  click('Mod sources');
  const write = deferMutation();
  click('Save');
  expect(mutations()).toHaveLength(1);
  expect(screen.getByRole('button', { name: 'Discard' })).toHaveProperty('disabled', true);
  await act(async () => write.resolve({ sourceRefresh: { enabled: false, intervalMs: 7_200_000, staleMs: 60_000 } }));
  await screen.findByRole('heading', { name: 'Mod sources' });
  expect(mutations()).toHaveLength(1);
  click('Automatic source checks');
  const nextInput = await screen.findByLabelText('Check every');
  fireEvent.change(nextInput, { target: { value: '3' } });
  click('Installed mods');
  click('Discard');
  await screen.findByRole('heading', { name: 'Mod details' });
  expect(mutations()).toHaveLength(1);
});

it.each(['Save', 'Discard'] as const)('Mods failed blur autosave retains the original subsection for explicit %s', async choice => {
  mount('Mods');
  const input = await focusDraft('Mods');
  const write = deferMutation();
  clickWithFocus(screen.getByRole('button', { name: 'Mod sources' }));
  await act(async () => write.reject(new Error('offline')));
  const dialog = await screen.findByRole('alertdialog');
  expect(input).toHaveProperty('value', '2');
  expect(mutations()).toHaveLength(1);
  const retry = choice === 'Save' ? deferMutation() : null;
  fireEvent.click(within(dialog).getByRole('button', { name: choice }));
  if (retry) {
    expect(mutations()).toHaveLength(2);
    expect(screen.queryByRole('heading', { name: 'Mod sources' })).toBeNull();
    await act(async () => retry.resolve({ sourceRefresh: { enabled: false, intervalMs: 7_200_000, staleMs: 60_000 } }));
  }
  await screen.findByRole('heading', { name: 'Mod sources' });
  expect(mutations()).toHaveLength(choice === 'Save' ? 2 : 1);
});
it('Mods active subsection is a no-op for an unblurred dirty draft', async () => {
  mount('Mods');
  const input = await focusDraft('Mods');
  click('Automatic source checks');
  click('Mods');
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(input).toHaveProperty('value', '2');
  expect(mutations()).toHaveLength(0);
});
