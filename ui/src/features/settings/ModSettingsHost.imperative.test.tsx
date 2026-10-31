import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ConfirmProvider } from '../../app/ConfirmDialog';
import { UnsavedChangesProvider, useUnsavedNavigation, type UnsavedDraft } from '../../app/UnsavedChanges';
import { ModSettingsHost, type SettingsSurface } from './ModSettingsHost';

type Context = {
  section: string;
  primary: SettingsSurface;
  overflow: SettingsSurface | null;
  setDraft: (draft: UnsavedDraft | null) => void;
  navigate: (proceed: () => void) => void;
  confirm: (options: { title: string; message: string; confirmLabel?: string; tone?: 'danger' | 'default' }) => Promise<boolean>;
};
const { mountSettings } = vi.hoisted(() => ({ mountSettings: vi.fn() }));
const targets: HTMLElement[] = [];
afterEach(() => { cleanup(); targets.splice(0).forEach(node => node.remove()); mountSettings.mockReset(); Reflect.deleteProperty(globalThis, '__modSettingsTestMount'); });
const target = (className: string) => { const node = document.createElement('section'); node.className = className; document.body.append(node); targets.push(node); return node; };
function Leave({ done }: { done: () => void }) { const navigate = useUnsavedNavigation(); return <button onClick={() => navigate(done)}>App destination</button>; }
function mountHost(done = vi.fn(), strict = false) {
  Object.assign(globalThis, { __modSettingsTestMount: mountSettings });
  const nav = target('settings-prototype-sections');
  const overflow = target('settings-prototype-overflow');
  const props = { modId: 'fixture', settingsUrl: './ModSettingsImperativeFixture', agents: [], onAgentsChanged: async () => {}, navigationTarget: nav, overflowTarget: overflow };
  const ui = <ConfirmProvider><UnsavedChangesProvider><div className="settings-prototype-configuration"><ModSettingsHost {...props} /></div><Leave done={done} /></UnsavedChangesProvider></ConfirmProvider>;
  return { ...render(strict ? <StrictMode>{ui}</StrictMode> : ui), nav, overflow, done };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function unload() { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; }
const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }));

// Simulate an imperative, memory-only inventory/editor without network calls.
function editor(saveResult: () => Promise<boolean> = async () => true) {
  const saves = vi.fn(saveResult);
  const discards = vi.fn();
  mountSettings.mockImplementation((context: Context) => {
    const primary = document.createElement('section');
    primary.className = 'setting-section';
    primary.innerHTML = `<h2>Editor ${context.section}</h2><div class="settings-form"><div class="settings-field-pair"><label class="field">Name<input aria-label="Name" value="saved"></label></div><div class="model-actions"><button class="primary" type="button">Save editor</button></div></div>`;
    const inventory = document.createElement('section');
    inventory.className = 'setting-section';
    inventory.innerHTML = '<h2>Inventory</h2><div class="memory-connection-list"><article class="memory-connection"><button class="memory-connection-select" type="button" aria-pressed="false"><strong>Other item</strong></button></article></div>';
    context.primary.replace(primary); context.overflow?.replace(inventory);
    const input = primary.querySelector('input')!;
    let baseline = 'saved';
    let busy = false;
    const publish = () => context.setDraft({ dirty: input.value !== baseline, busy, save, discard });
    const save = async () => {
      if (!input.value.trim()) { primary.dataset.error = 'Name is required'; return false; }
      const submitted = input.value;
      busy = true; publish();
      const ok = await saves();
      if (ok) baseline = submitted; else primary.dataset.error = 'Save failed';
      busy = false; publish();
      return ok && input.value === baseline;
    };
    const discard = () => { discards(); input.value = baseline; publish(); };
    input.addEventListener('input', publish);
    inventory.querySelector('button')!.addEventListener('click', () => context.navigate(() => { primary.dataset.selected = 'other'; }));
    primary.querySelector('button')!.addEventListener('click', () => void save());
    publish();
  });
  return { saves, discards };
}
async function ready() { await screen.findByRole('heading', { name: 'Editor one' }); return screen.getByLabelText('Name') as HTMLInputElement; }
function edit(value: string) { fireEvent.input(screen.getByLabelText('Name'), { target: { value } }); }

it('uses actual primary and overflow surface paths, shared semantic markup, and guards item selection', async () => {
  const { discards } = editor(); const view = mountHost(); const input = await ready();
  const primary = view.container.querySelector('.settings-prototype-configuration > .mod-settings-mount > .mod-settings-surface > .setting-section');
  const inventory = view.overflow.querySelector(':scope > .mod-settings-surface.settings-overflow-content > .setting-section');
  expect(primary?.querySelector('.settings-form .settings-field-pair .field input')).toBe(input);
  expect(inventory?.querySelector('.memory-connection-list .memory-connection-select strong')?.textContent).toBe('Other item');
  expect(view.overflow.querySelector('.mod-settings-mount')).toBeNull();
  expect(view.container.querySelector('.memory-connection-list')).toBeNull();
  edit('draft'); click('Other item');
  expect(screen.getByRole('alertdialog', { name: 'Unsaved changes' })).toBeTruthy();
  click('Stay'); expect(primary?.getAttribute('data-selected')).toBeNull(); expect(input.value).toBe('draft');
  click('Other item'); click('Discard');
  expect(primary?.getAttribute('data-selected')).toBe('other'); expect(input.value).toBe('saved'); expect(discards).toHaveBeenCalledOnce();
});

it('publishes latest callbacks, permits dirty revert/clear and warns on dirty or busy native unload', async () => {
  editor(); const { done } = mountHost(); await ready();
  const context: Context = mountSettings.mock.calls[0][0];
  expect(unload()).toBe(false);
  edit('draft'); expect(unload()).toBe(true);
  click('One'); expect(screen.queryByRole('alertdialog')).toBeNull();
  edit('saved'); expect(unload()).toBe(false);
  const first = vi.fn(async () => true), latest = vi.fn(async () => { context.setDraft(null); return true; });
  act(() => { context.setDraft({ dirty: true, busy: false, save: first, discard: vi.fn() }); context.setDraft({ dirty: true, busy: false, save: latest, discard: vi.fn() }); });
  click('App destination'); click('Save'); await waitFor(() => expect(done).toHaveBeenCalledOnce());
  expect(first).not.toHaveBeenCalled(); expect(latest).toHaveBeenCalledOnce(); expect(unload()).toBe(false);
  act(() => context.setDraft({ dirty: false, busy: true, save: latest, discard: vi.fn() }));
  expect(unload()).toBe(true); click('App destination'); expect(done).toHaveBeenCalledOnce();
  act(() => context.setDraft(null)); expect(unload()).toBe(false);
});

it('uses shared subsection guard for Stay, failed validation, failed save, then successful save', async () => {
  const result = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true); const { saves } = editor(result);
  const { nav } = mountHost(); const input = await ready();
  edit(''); click('Two'); click('Save');
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  expect(input.value).toBe(''); expect(input.closest('section')?.getAttribute('data-error')).toBe('Name is required'); expect(saves).not.toHaveBeenCalled();
  edit('draft'); click('Two'); click('Save');
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  expect(input.value).toBe('draft'); expect(input.closest('section')?.getAttribute('data-error')).toBe('Save failed');
  expect(within(nav).getByRole('button', { name: 'One' }).getAttribute('aria-current')).toBe('page');
  click('Two'); click('Stay'); expect(input.value).toBe('draft');
  click('Two'); click('Save'); await screen.findByRole('heading', { name: 'Editor two' }); expect(saves).toHaveBeenCalledTimes(2);
});

it('does not navigate during in-flight saves or lose newer edits made before a save resolves', async () => {
  const request = deferred<boolean>(); const { saves } = editor(() => request.promise); const { done } = mountHost(); await ready();
  edit('draft'); click('App destination'); click('Save');
  expect(saves).toHaveBeenCalledOnce(); expect(unload()).toBe(true);
  expect(screen.getByRole('button', { name: 'Discard' })).toHaveProperty('disabled', true);
  click('Two'); click('App destination'); expect(done).not.toHaveBeenCalled();
  edit('newer'); await act(async () => request.resolve(true));
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  expect(done).not.toHaveBeenCalled(); expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('newer');
  click('App destination'); click('Discard'); expect(done).toHaveBeenCalledOnce();
  expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('draft');
});

it('unregisters on unmount and ignores late save, setDraft and navigation, including queued destination', async () => {
  const request = deferred<boolean>(); const { saves } = editor(() => request.promise); const { done, rerender } = mountHost(); await ready();
  const context: Context = mountSettings.mock.calls[0][0];
  edit('draft'); click('App destination'); click('Save'); expect(saves).toHaveBeenCalledOnce();
  // Preserve both providers while removing only the imperative host.
  rerender(<ConfirmProvider><UnsavedChangesProvider><Leave done={done} /></UnsavedChangesProvider></ConfirmProvider>);
  const stale = vi.fn();
  await act(async () => { context.setDraft({ dirty: true, busy: false, save: async () => true, discard: vi.fn() }); context.navigate(stale); });
  expect(stale).not.toHaveBeenCalled(); expect(done).not.toHaveBeenCalled(); expect(unload()).toBe(false);
  await act(async () => request.resolve(true));
  expect(done).not.toHaveBeenCalled();
  click('App destination'); expect(done).toHaveBeenCalledOnce(); expect(screen.queryByRole('alertdialog')).toBeNull();
});

it('uses shared confirmation and denies resolved or newly requested confirms after disposal, with async cleanup', async () => {
  const mounted = deferred<() => void>(); mountSettings.mockImplementation(() => mounted.promise);
  const view = mountHost(); await waitFor(() => expect(mountSettings).toHaveBeenCalledOnce());
  const context: Context = mountSettings.mock.calls[0][0];
  let result!: Promise<boolean>;
  act(() => { result = context.confirm({ title: 'Remove?', message: 'Proceed?', confirmLabel: 'Remove', tone: 'danger' }); });
  expect(screen.getByRole('alertdialog', { name: 'Remove?' })).toBeTruthy();
  view.unmount();
  const cleanupFn = vi.fn(); await act(async () => mounted.resolve(cleanupFn)); expect(cleanupFn).toHaveBeenCalledOnce();
  expect(await result).toBe(false); expect(await context.confirm({ title: 'Late', message: 'Late' })).toBe(false);
});

it('invalidates pending confirmation even if the provider remains mounted and the user later confirms', async () => {
  editor(); const { rerender, done } = mountHost(); await ready();
  const context: Context = mountSettings.mock.calls[0][0]; let result!: Promise<boolean>;
  act(() => { result = context.confirm({ title: 'Remove?', message: 'Proceed?' }); });
  rerender(<ConfirmProvider><UnsavedChangesProvider><Leave done={done} /></UnsavedChangesProvider></ConfirmProvider>);
  click('Confirm'); await expect(result).resolves.toBe(false);
});

it('stale mounts cannot register or navigate in StrictMode after a subsection transition', async () => {
  editor(); const { done } = mountHost(vi.fn(), true); await ready();
  const old: Context = mountSettings.mock.calls.at(-1)![0];
  click('Two'); await screen.findByRole('heading', { name: 'Editor two' });
  const stale = vi.fn();
  act(() => { old.setDraft({ dirty: true, busy: false, save: async () => true, discard: vi.fn() }); old.navigate(stale); });
  expect(stale).not.toHaveBeenCalled(); expect(unload()).toBe(false);
  click('App destination'); expect(done).toHaveBeenCalledOnce();
});

it('unregisters when a host disappears while the provider and navigation dialog remain mounted', async () => {
  const done = vi.fn();
  const nav = target('settings-prototype-sections'); const overflow = target('settings-prototype-overflow');
  const props = { modId: 'fixture', settingsUrl: './ModSettingsImperativeFixture', agents: [], onAgentsChanged: async () => {}, navigationTarget: nav, overflowTarget: overflow };
  Object.assign(globalThis, { __modSettingsTestMount: mountSettings }); editor();
  const makeUi = (show: boolean) => <ConfirmProvider><UnsavedChangesProvider>{show && <div className="settings-prototype-configuration"><ModSettingsHost {...props} /></div>}<Leave done={done} /></UnsavedChangesProvider></ConfirmProvider>;
  const view = render(makeUi(true)); await ready();
  const context: Context = mountSettings.mock.calls[0][0];
  edit('draft'); click('App destination'); expect(screen.getByRole('alertdialog')).toBeTruthy();
  view.rerender(makeUi(false));
  act(() => { context.setDraft({ dirty: true, busy: false, save: async () => true, discard: vi.fn() }); context.navigate(vi.fn()); });
  expect(unload()).toBe(false);
  // If the dialog remains, resolving it cannot re-register the old scope.
  if (screen.queryByRole('alertdialog')) click('Stay');
  click('App destination'); expect(done).toHaveBeenCalledOnce();
});

it('does not follow a pending external destination after its draft mount is forcibly removed', async () => {
  const done = vi.fn();
  const nav = target('settings-prototype-sections'); const overflow = target('settings-prototype-overflow');
  const props = { modId: 'fixture', settingsUrl: './ModSettingsImperativeFixture', agents: [], onAgentsChanged: async () => {}, navigationTarget: nav, overflowTarget: overflow };
  Object.assign(globalThis, { __modSettingsTestMount: mountSettings }); editor();
  const makeUi = (show: boolean) => <ConfirmProvider><UnsavedChangesProvider>{show && <div className="settings-prototype-configuration"><ModSettingsHost {...props} /></div>}<Leave done={done} /></UnsavedChangesProvider></ConfirmProvider>;
  const view = render(makeUi(true)); await ready(); edit('draft'); click('App destination');
  view.rerender(makeUi(false));
  const dialog = screen.queryByRole('alertdialog');
  if (dialog) fireEvent.click(within(dialog).getByRole('button', { name: 'Discard' }));
  expect(done).not.toHaveBeenCalled();
});

it('does not resume an external destination when a host unmounts mid-save under the same provider', async () => {
  const pending = deferred<boolean>(); const done = vi.fn(); editor(() => pending.promise);
  const nav = target('settings-prototype-sections'); const overflow = target('settings-prototype-overflow');
  const props = { modId: 'fixture', settingsUrl: './ModSettingsImperativeFixture', agents: [], onAgentsChanged: async () => {}, navigationTarget: nav, overflowTarget: overflow };
  Object.assign(globalThis, { __modSettingsTestMount: mountSettings });
  const makeUi = (show: boolean) => <ConfirmProvider><UnsavedChangesProvider>{show && <div className="settings-prototype-configuration"><ModSettingsHost {...props} /></div>}<Leave done={done} /></UnsavedChangesProvider></ConfirmProvider>;
  const view = render(makeUi(true)); await ready(); edit('draft'); click('App destination'); click('Save');
  view.rerender(makeUi(false)); expect(unload()).toBe(false);
  await act(async () => pending.resolve(true));
  expect(done).not.toHaveBeenCalled(); expect(screen.queryByRole('alertdialog')).toBeNull();
  click('App destination'); expect(done).toHaveBeenCalledOnce();
});
