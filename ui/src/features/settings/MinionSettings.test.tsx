import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../../app/api';
import { UnsavedChangesProvider } from '../../app/UnsavedChanges';
import { MinionSettings } from './MinionSettings';
import type { MinionProfile } from './MinionProfiles';
vi.mock('../../app/api', () => ({ api: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.mocked(api).mockReset();
});
const defaults = {
  maxDepth: 1,
  defaultHarness: 'burrow',
  codexModel: null,
  claudeModel: null,
  defaultMinionProfileId: null,
};
const reviewer: MinionProfile = {
  id: 'review',
  name: 'Imported Reviewer',
  enabled: true,
  harness: 'burrow',
  model: null,
  instructions: 'Global instructions',
  executionHostId: 'local',
};
function setup(overrideEnabled = false, roster = [reviewer]) {
  let settings = {
    ok: true,
    ...defaults,
    maxDepth: 2,
    overrideEnabled,
    profileOverrides: { review: { instructions: 'Saved instructions' }, other: { enabled: false } },
    effective: defaults,
  };
  vi.mocked(api).mockImplementation(async (path, init) => {
    if (init?.method === 'PUT') {
      const patch = JSON.parse(String(init.body));
      if (String(path).startsWith('/api/settings/minions/'))
        return { ok: true, profile: { ...reviewer, ...patch } } as never;
      settings = { ...settings, ...patch };
      return String(path).startsWith('/api/agents/')
        ? settings
        : ({ ok: true, ...defaults, ...patch } as never);
    }
    if (String(path).startsWith('/api/settings/minions'))
      return { ok: true, profiles: roster } as never;
    if (String(path).includes('model-connections')) return { connections: [] } as never;
    if (String(path).includes('/api/mods/')) return { ok: true, gateways: [] } as never;
    return String(path).startsWith('/api/agents/')
      ? settings
      : ({ ok: true, ...defaults } as never);
  });
}
const puts = () => vi.mocked(api).mock.calls.filter(([, init]) => init?.method === 'PUT');
const body = (index = 0) => JSON.parse(String(puts()[index][1]?.body));

it('inherits effective defaults and restores saved settings with toggle-only writes', async () => {
  setup();
  render(<MinionSettings agentId="a/b" />);
  await screen.findByText(/Inheriting global defaults/);
  expect(screen.getByLabelText('Maximum minion depth')).toHaveProperty('value', '1');
  expect(screen.getByLabelText('Maximum minion depth').closest('fieldset')?.disabled).toBe(true);
  expect(screen.queryByLabelText('Standing instructions')).toBeNull();
  fireEvent.click(screen.getByLabelText('Override global minion settings'));
  await screen.findByDisplayValue('Saved instructions');
  expect(body()).toEqual({ overrideEnabled: true });
  expect(puts()[0][0]).toBe('/api/agents/a%2Fb/minion-settings');
  expect(screen.getByLabelText('Maximum minion depth')).toHaveProperty('value', '2');
  fireEvent.click(screen.getByLabelText('Override global minion settings'));
  await screen.findByText(/Inheriting global defaults/);
  expect(body(1)).toEqual({ overrideEnabled: false });
  fireEvent.click(screen.getByLabelText('Override global minion settings'));
  await screen.findByDisplayValue('Saved instructions');
  expect(screen.getByLabelText('Execution host')).toHaveProperty('value', 'local');
  expect(screen.getByLabelText('Maximum minion depth')).toHaveProperty('value', '2');
});

it('writes only changed global defaults and retains Imported names without a carousel', async () => {
  setup();
  render(<MinionSettings />);
  await screen.findByDisplayValue('Imported Reviewer');
  expect(screen.getByRole('button', { name: 'Imported Reviewer' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Scroll minion/ })).toBeNull();
  fireEvent.change(screen.getByLabelText('Maximum minion depth'), { target: { value: '0' } });
  fireEvent.click(screen.getByText('Save minion defaults'));
  await waitFor(() => expect(puts()).toHaveLength(1));
  expect(puts()[0][0]).toBe('/api/settings/minion-settings');
  expect(body()).toEqual({ maxDepth: 0 });
  expect(vi.mocked(api).mock.calls.some(([p]) => p.includes('/api/agents/'))).toBe(false);
});

it('edits saved agent defaults and specialist overrides in the third column while preserving sibling patches and default drafts', async () => {
  setup(true);
  const third = document.createElement('section');
  document.body.append(third);
  const view = render(<MinionSettings agentId="agent" overflowTarget={third} />);
  try {
    await screen.findByDisplayValue('Saved instructions');
    expect(third.contains(screen.getByLabelText('Maximum minion depth'))).toBe(true);
    expect(third.contains(screen.getByLabelText('Standing instructions'))).toBe(true);
    expect(view.container.contains(screen.getByRole('button', { name: 'Imported Reviewer' }))).toBe(
      true,
    );
    fireEvent.change(screen.getByLabelText('Maximum minion depth'), { target: { value: '0' } });
    fireEvent.change(screen.getByLabelText('Standing instructions'), {
      target: { value: 'Agent instructions' },
    });
    fireEvent.click(screen.getByText('Save minion'));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(body()).toEqual({
      profileOverrides: {
        review: { instructions: 'Agent instructions' },
        other: { enabled: false },
      },
    });
    await waitFor(() =>
      expect(screen.getByText('Save minion defaults')).toHaveProperty('disabled', false),
    );
    expect(screen.getByLabelText('Maximum minion depth')).toHaveProperty('value', '0');
    expect(puts().some(([p]) => p.startsWith('/api/settings/minions/'))).toBe(false);
    expect(
      vi.mocked(api).mock.calls.some(([p]) => p === '/api/settings/minions?agentId=agent'),
    ).toBe(true);
    expect(vi.mocked(api).mock.calls.some(([p]) => p === '/api/settings/minions')).toBe(true);
  } finally {
    view.unmount();
    third.remove();
  }
});

it('cannot enable a globally disabled specialist from agent overrides', async () => {
  setup(true, [{ ...reviewer, enabled: false }]);
  render(<MinionSettings agentId="agent" />);
  await screen.findByDisplayValue('Saved instructions');
  expect(screen.getByLabelText('Enabled')).toHaveProperty('disabled', true);
  expect(screen.getByLabelText('Enabled')).toHaveProperty('checked', false);
});

it('preserves a failed toggle and supports retry without writing saved values', async () => {
  setup();
  render(<MinionSettings agentId="agent" />);
  await screen.findByText(/Inheriting global defaults/);
  vi.mocked(api).mockRejectedValueOnce(new Error('offline'));
  fireEvent.click(screen.getByLabelText('Override global minion settings'));
  await screen.findByText(/offline/);
  expect(screen.getByLabelText('Override global minion settings')).toHaveProperty('checked', false);
  fireEvent.click(screen.getByLabelText('Override global minion settings'));
  await screen.findByDisplayValue('Saved instructions');
  expect(body(1)).toEqual({ overrideEnabled: true });
});

it('guards unsaved specialist edits before disabling overrides', async () => {
  setup(true);
  render(
    <UnsavedChangesProvider>
      <MinionSettings agentId="agent" />
    </UnsavedChangesProvider>,
  );
  await screen.findByDisplayValue('Saved instructions');
  fireEvent.change(screen.getByLabelText('Standing instructions'), { target: { value: 'Draft' } });
  fireEvent.click(screen.getByLabelText('Override global minion settings'));
  fireEvent.click(within(await screen.findByRole('alertdialog')).getByText('Stay'));
  expect(puts()).toHaveLength(0);
  expect(screen.getByLabelText('Standing instructions')).toHaveProperty('value', 'Draft');
});

it('reports malformed settings and retries without enabling editor writes', async () => {
  setup();
  const original = vi.mocked(api).getMockImplementation()!;
  let malformed = true;
  vi.mocked(api).mockImplementation(async (path, init) => {
    if (path === '/api/settings/minion-settings' && malformed) return null as never;
    return original(path, init);
  });
  render(<MinionSettings />);
  await screen.findByText(/Invalid minion settings response/);
  expect(screen.queryByText('Save minion defaults')).toBeNull();
  expect(puts()).toHaveLength(0);
  malformed = false;
  fireEvent.click(screen.getByText('Retry minion settings'));
  await screen.findByLabelText('Maximum minion depth');
  expect(screen.getByText('Save minion defaults')).toHaveProperty('disabled', true);
});
