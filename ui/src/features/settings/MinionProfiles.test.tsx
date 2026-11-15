import { UnsavedChangesProvider } from '../../app/UnsavedChanges';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api, type ModelConnection } from '../../app/api';
import { MinionProfiles, minionProviders, type MinionProfile } from './MinionProfiles';
vi.mock('../../app/api', () => ({ api: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.mocked(api).mockReset();
});
const profile: MinionProfile = {
  id: 'p1',
  name: 'Reviewer',
  harness: 'burrow',
  enabled: true,
  model: null,
  executionHostId: null,
  instructions: 'Review carefully',
};
function setup(profiles = [profile], defaultMinionProfileId: string | null = null) {
  vi.mocked(api).mockImplementation(async (path, init) => {
    if (init?.method)
      return {
        ok: true,
        profile: { ...JSON.parse(String(init.body)), id: 'p1' },
        defaultMinionProfileId: JSON.parse(String(init.body)).defaultMinionProfileId,
      } as never;
    if (String(path).includes('/settings/minions')) return { ok: true, profiles } as never;
    if (String(path).includes('model-connections')) return { connections: [] } as never;
    return { ok: true, defaultMinionProfileId } as never;
  });
}
it('keeps a missing default visible and writes only its field', async () => {
  setup([], 'gone');
  render(<MinionProfiles agentId="agent/a" defaultOnly />);
  expect(await screen.findByText(/Spawning is blocked/)).toBeTruthy();
  expect((screen.getByLabelText('Default minion profile') as HTMLSelectElement).value).toBe('gone');
  fireEvent.change(screen.getByLabelText('Default minion profile'), { target: { value: '' } });
  fireEvent.click(screen.getByText('Save default minion'));
  await waitFor(() =>
    expect(api).toHaveBeenLastCalledWith(
      '/api/agents/agent%2Fa/minion-settings',
      expect.objectContaining({ body: JSON.stringify({ defaultMinionProfileId: null }) }),
    ),
  );
});
it('disables without clearing instructions, model or host', async () => {
  setup([{ ...profile, executionHostId: 'host-1' }]);
  render(<MinionProfiles agentId="a" />);
  await screen.findByDisplayValue('Reviewer');
  fireEvent.click(screen.getByLabelText('Enabled'));
  fireEvent.click(screen.getByText('Save minion'));
  await waitFor(() =>
    expect(api).toHaveBeenLastCalledWith(
      '/api/settings/minions/p1?agentId=a',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({
          ...profile,
          id: undefined,
          enabled: false,
          executionHostId: 'host-1',
        }),
      }),
    ),
  );
});
it('allows Burrow inheritance but requires a native model', async () => {
  setup();
  render(<MinionProfiles agentId="a" />);
  await screen.findByDisplayValue('Reviewer');
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Changed' } });
  expect((screen.getByText('Save minion') as HTMLButtonElement).disabled).toBe(false);
  fireEvent.change(screen.getByLabelText('Harness'), { target: { value: 'codex' } });
  expect((screen.getByText('Save minion') as HTMLButtonElement).disabled).toBe(true);
});
it('offers all enabled connections for Burrow and only eligible native pools', () => {
  const connections = [
    { id: 'pool', apiType: 'openai-lb', codexEligible: true, models: [{ id: 'm' }] },
    { id: 'bad', apiType: 'openai-lb', codexEligible: false, models: [] },
    { id: 'off', apiType: 'openai-lb', codexEligible: true, enabled: false, models: [] },
  ] as ModelConnection[];
  expect(minionProviders(connections, 'burrow').map((p) => p.id)).toEqual(['pool', 'bad']);
  expect(minionProviders(connections, 'codex').map((p) => p.id)).toEqual(['pool']);
});

function hostSetup(fail = false) {
  setup([{ ...profile, executionHostId: 'missing' }]);
  const base = vi.mocked(api).getMockImplementation()!;
  vi.mocked(api).mockImplementation(async (path, init) => {
    if (String(path).includes('/api/mods/')) {
      if (fail) throw new Error('catalog offline');
      return {
        ok: true,
        gateways: String(path).endsWith('gateway-trust')
          ? [{ gatewayId: 'one' }, { gatewayId: 'two' }]
          : [
              { gatewayId: 'one', connected: true },
              { gatewayId: 'unconfigured', connected: true },
            ],
      } as never;
    }
    return base(path, init);
  });
}
it('joins configured gateway identities to live state and preserves unavailable pins', async () => {
  hostSetup();
  render(<MinionProfiles agentId="a" />);
  expect(await screen.findByText('one — Connected')).toBeTruthy();
  expect(screen.getByText('two — Disconnected')).toBeTruthy();
  expect(screen.getByText('missing — unavailable')).toBeTruthy();
  expect(screen.queryByText(/unconfigured/)).toBeNull();
  fireEvent.change(screen.getByLabelText('Execution host'), { target: { value: '' } });
  fireEvent.click(screen.getByText('Save minion'));
  await waitFor(() =>
    expect(api).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({ body: expect.stringContaining('"executionHostId":null') }),
    ),
  );
});
it('shows catalog failure and retry without clearing the saved host', async () => {
  hostSetup(true);
  render(<MinionProfiles agentId="a" />);
  await screen.findByText(/Execution host catalog failed/);
  expect((screen.getByLabelText('Execution host') as HTMLSelectElement).value).toBe('missing');
  hostSetup();
  fireEvent.click(screen.getByText('Retry execution hosts'));
  await screen.findByText('one — Connected');
  expect(screen.queryByText(/Execution host catalog failed/)).toBeNull();
});
it.each([{ id: 'p1' }, { ...profile, name: 'Unacknowledged' }])(
  'rejects invalid or mismatched save acknowledgement',
  async (response) => {
    setup();
    render(<MinionProfiles agentId="a" />);
    await screen.findByDisplayValue('Reviewer');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Changed' } });
    vi.mocked(api).mockResolvedValue({ ok: true, profile: response });
    fireEvent.click(screen.getByText('Save minion'));
    await screen.findByText(/Profile was not acknowledged/);
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Changed');
    expect((screen.getByText('Save minion') as HTMLButtonElement).disabled).toBe(false);
  },
);

it('guards roster switches with stay and discard', async () => {
  setup([profile, { ...profile, id: 'p2', name: 'Writer' }]);
  render(
    <UnsavedChangesProvider>
      <MinionProfiles agentId="a" />
    </UnsavedChangesProvider>,
  );
  await screen.findByDisplayValue('Reviewer');
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Dirty' } });
  fireEvent.click(screen.getByRole('button', { name: 'Writer' }));
  await screen.findByRole('alertdialog');
  fireEvent.click(screen.getByText('Stay'));
  expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Dirty');
  fireEvent.click(screen.getByRole('button', { name: 'Writer' }));
  fireEvent.click(await screen.findByText('Discard'));
  await screen.findByDisplayValue('Writer');
  expect(vi.mocked(api).mock.calls.some(([, init]) => !!init?.method)).toBe(false);
});

it('edits the global roster without reading or writing any agent default and accepts long text', async () => {
  const name = 'n'.repeat(121);
  const instructions = 'i'.repeat(8001);
  setup([{ ...profile, name, instructions }]);
  render(<MinionProfiles />);
  await screen.findByDisplayValue(name);
  expect((screen.getByLabelText('Name') as HTMLInputElement).hasAttribute('maxlength')).toBe(false);
  expect(
    (screen.getByLabelText('Standing instructions') as HTMLTextAreaElement).hasAttribute(
      'maxlength',
    ),
  ).toBe(false);
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: name + 'x' } });
  fireEvent.click(screen.getByText('Save minion'));
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith(
      '/api/settings/minions/p1',
      expect.objectContaining({ method: 'PUT' }),
    ),
  );
  expect(vi.mocked(api).mock.calls.some(([p]) => String(p).includes('/api/agents/'))).toBe(false);
});

it('distinguishes explicit Core from inherited execution and discovers provider hosts for the global roster', async () => {
  hostSetup();
  render(<MinionProfiles />);
  await screen.findByText('one — Connected');
  fireEvent.change(screen.getByLabelText('Execution host'), { target: { value: 'local' } });
  fireEvent.click(screen.getByText('Save minion'));
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith(
      '/api/settings/minions/p1',
      expect.objectContaining({ body: expect.stringContaining('"executionHostId":"local"') }),
    ),
  );
});

it('keeps agent default selections independent while using the same shared roster', async () => {
  setup([profile], 'p1');
  const view = (agentId: string) => <MinionProfiles key={agentId} agentId={agentId} defaultOnly />;
  const { rerender } = render(view('a'));
  await screen.findByText('Reviewer');
  fireEvent.change(screen.getByLabelText('Default minion profile'), { target: { value: '' } });
  fireEvent.click(screen.getByText('Save default minion'));
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith(
      '/api/agents/a/minion-settings',
      expect.objectContaining({ body: '{"defaultMinionProfileId":null}' }),
    ),
  );
  rerender(view('b'));
  await screen.findByText('Reviewer');
  expect((screen.getByLabelText('Default minion profile') as HTMLSelectElement).value).toBe('p1');
  expect(vi.mocked(api).mock.calls.filter(([, init]) => init?.method).length).toBe(1);
});
