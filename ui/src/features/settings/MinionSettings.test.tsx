import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../../app/api';
import { UnsavedChangesProvider } from '../../app/UnsavedChanges';
import { MinionSettings } from './MinionSettings';
vi.mock('../../app/api', () => ({ api: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.mocked(api).mockReset();
});
const pair = { connectionId: 'native', model: 'model' };
const defaults = {
  maxDepth: 1,
  defaultHarness: 'burrow',
  burrowModel: null,
  codexEnabled: false,
  claudeEnabled: false,
  geminiEnabled: false,
  codexModel: null,
  claudeModel: null,
  geminiModel: null,
};
function setup(overrideEnabled = false, extra = {}) {
  let settings = {
    ok: true,
    ...defaults,
    maxDepth: 2,
    codexModel: pair,
    codexEnabled: true,
    overrideEnabled,
    effective: defaults,
    ...extra,
  };
  vi.mocked(api).mockImplementation(async (path, init) => {
    if (String(path).includes('/minions')) throw new Error('Roster must not be read');
    if (String(path).includes('model-connections'))
      return {
        connections: [
          {
            id: 'native',
            provider: 'Native',
            apiType: 'openai-lb',
            enabled: true,
            codexEligible: true,
            models: [{ id: 'model' }],
          },
        ],
      } as never;
    if (init?.method === 'PUT') {
      settings = { ...settings, ...JSON.parse(String(init.body)) };
      return settings as never;
    }
    return settings as never;
  });
}
const puts = () => vi.mocked(api).mock.calls.filter(([, init]) => init?.method === 'PUT');
const body = (index = 0) => JSON.parse(String(puts()[index][1]?.body));
it('inherits effective defaults and restores saved agent values with toggle-only writes', async () => {
  setup();
  render(<MinionSettings agentId="a/b" />);
  await screen.findByText(/Inheriting global defaults/);
  expect(screen.getByLabelText('Maximum minion depth')).toHaveProperty('value', '1');
  expect(screen.getByLabelText('Codex Enabled')).toHaveProperty('checked', false);
  expect(screen.getByLabelText('Maximum minion depth').closest('fieldset')?.disabled).toBe(true);
  for (const next of [true, false, true]) {
    fireEvent.click(screen.getByLabelText('Override global minion settings'));
    await waitFor(() =>
      expect(screen.getByLabelText('Override global minion settings')).toHaveProperty(
        'checked',
        next,
      ),
    );
  }
  expect(puts().map((_, i) => body(i))).toEqual([
    { overrideEnabled: true },
    { overrideEnabled: false },
    { overrideEnabled: true },
  ]);
  expect(puts()[0][0]).toBe('/api/agents/a%2Fb/minion-settings');
  expect(screen.getByLabelText('Maximum minion depth')).toHaveProperty('value', '2');
  expect(screen.getByLabelText('Codex Enabled')).toHaveProperty('checked', true);
  expect(screen.getByLabelText('Codex model')).toHaveProperty('value', 'model');
});
it('renders simple global controls without roster/profile prerequisites and saves only changed fields', async () => {
  setup();
  render(<MinionSettings />);
  await screen.findByLabelText('Burrow provider');
  expect(screen.queryByText(/specialist|Default minion profile/i)).toBeNull();
  fireEvent.click(screen.getByLabelText('Codex Enabled'));
  fireEvent.click(screen.getByText('Save minion defaults'));
  await waitFor(() => expect(puts()).toHaveLength(1));
  expect(body()).toEqual({ codexEnabled: false });
  expect(screen.getByLabelText('Codex model')).toHaveProperty('value', 'model');
  expect(puts()[0][0]).toBe('/api/settings/minion-settings');
});
it('keeps general and Burrow controls in the main column and native controls in overflow', async () => {
  setup(true);
  const third = document.createElement('section');
  document.body.append(third);
  const view = render(<MinionSettings agentId="agent" overflowTarget={third} />);
  try {
    await screen.findByLabelText('Burrow provider');
    expect(view.container.contains(screen.getByLabelText('Maximum minion depth'))).toBe(true);
    expect(view.container.contains(screen.getByLabelText('Burrow provider'))).toBe(true);
    expect(third.contains(screen.getByLabelText('Codex Enabled'))).toBe(true);
    expect(third.contains(screen.getByLabelText('Claude model'))).toBe(true);
    fireEvent.change(screen.getByLabelText('Burrow provider'), { target: { value: 'native' } });
    fireEvent.click(screen.getByText('Save minion defaults'));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(body()).toEqual({ burrowModel: pair });
  } finally {
    view.unmount();
    third.remove();
  }
});
it('guards unsaved defaults before disabling overrides', async () => {
  setup(true);
  render(
    <UnsavedChangesProvider>
      <MinionSettings agentId="agent" />
    </UnsavedChangesProvider>,
  );
  await screen.findByLabelText('Burrow provider');
  fireEvent.change(screen.getByLabelText('Maximum minion depth'), { target: { value: '0' } });
  fireEvent.click(screen.getByLabelText('Override global minion settings'));
  fireEvent.click(within(await screen.findByRole('alertdialog')).getByText('Stay'));
  expect(puts()).toHaveLength(0);
  expect(screen.getByLabelText('Maximum minion depth')).toHaveProperty('value', '0');
});
it('retains failed toggle state and permits retry', async () => {
  setup();
  render(<MinionSettings agentId="agent" />);
  await screen.findByLabelText('Burrow provider');
  vi.mocked(api).mockRejectedValueOnce(new Error('offline'));
  fireEvent.click(screen.getByLabelText('Override global minion settings'));
  await screen.findByText(/offline/);
  expect(screen.getByLabelText('Override global minion settings')).toHaveProperty('checked', false);
  fireEvent.click(screen.getByLabelText('Override global minion settings'));
  await waitFor(() =>
    expect(screen.getByLabelText('Override global minion settings')).toHaveProperty(
      'checked',
      true,
    ),
  );
  expect(body(1)).toEqual({ overrideEnabled: true });
});
it('rejects malformed responses and retries', async () => {
  setup();
  const original = vi.mocked(api).getMockImplementation()!;
  let malformed = true;
  vi.mocked(api).mockImplementation(async (path, init) =>
    path === '/api/settings/minion-settings' && malformed ? (null as never) : original(path, init),
  );
  render(<MinionSettings />);
  await screen.findByText(/Invalid minion settings response/);
  expect(screen.queryByText('Save minion defaults')).toBeNull();
  malformed = false;
  fireEvent.click(screen.getByText('Retry minion settings'));
  await screen.findByLabelText('Burrow provider');
  expect(screen.getByText('Save minion defaults')).toHaveProperty('disabled', true);
});

it('uses the existing depth slider range and never offers or writes a default harness', async () => {
  setup(true);
  render(<MinionSettings agentId="agent" />);
  const slider = await screen.findByRole('slider', { name: 'Maximum minion depth' });
  expect(slider.getAttribute('min')).toBe('0');
  expect(slider.getAttribute('max')).toBe('2');
  expect(slider.getAttribute('step')).toBe('1');
  expect(screen.queryByLabelText('Default minion type')).toBeNull();
  for (const depth of [0, 1, 2]) {
    fireEvent.change(slider, { target: { value: String(depth) } });
    fireEvent.click(screen.getByText('Save minion defaults'));
    await waitFor(() => expect(body(puts().length - 1)).toEqual({ maxDepth: depth }));
    await waitFor(() =>
      expect(screen.getByText('Save minion defaults')).toHaveProperty('disabled', true),
    );
  }
});

it('saves Gemini toggles without changing models and preserves native Latest IDs and null clears', async () => {
  setup(true);
  const original = vi.mocked(api).getMockImplementation()!;
  vi.mocked(api).mockImplementation(async (path, init) => {
    if (String(path).includes('model-connections'))
      return {
        connections: [
          {
            id: 'google',
            provider: 'Google native',
            apiType: 'google-generative-language',
            enabled: true,
            geminiEligible: true,
            models: [{ id: 'gemini-latest', displayName: 'Gemini Latest' }],
          },
        ],
      } as never;
    return original(path, init);
  });
  render(<MinionSettings agentId="agent" />);
  await screen.findByLabelText('Gemini Enabled');
  fireEvent.click(screen.getByLabelText('Gemini Enabled'));
  fireEvent.click(screen.getByText('Save minion defaults'));
  await waitFor(() => expect(body()).toEqual({ geminiEnabled: true }));
  await waitFor(() =>
    expect(screen.getByText('Save minion defaults')).toHaveProperty('disabled', true),
  );
  fireEvent.change(screen.getByLabelText('Gemini provider'), { target: { value: 'google' } });
  fireEvent.click(screen.getByText('Save minion defaults'));
  await waitFor(() =>
    expect(body(1)).toEqual({ geminiModel: { connectionId: 'google', model: 'gemini-latest' } }),
  );
  await waitFor(() =>
    expect(screen.getByText('Save minion defaults')).toHaveProperty('disabled', true),
  );
  fireEvent.change(screen.getByLabelText('Gemini provider'), { target: { value: '' } });
  fireEvent.click(screen.getByText('Save minion defaults'));
  await waitFor(() => expect(body(2)).toEqual({ geminiModel: null, geminiModelLocked: false }));
});

for (const harness of ['burrow', 'codex', 'claude', 'gemini'] as const) {
  const label = harness[0].toUpperCase() + harness.slice(1);
  it(`saves ${harness} lock independently and atomically clears it with the model`, async () => {
    setup(true, { [`${harness}Model`]: pair });
    const original = vi.mocked(api).getMockImplementation()!;
    vi.mocked(api).mockImplementation(async (path, init) => {
      const result = (await original(path, init)) as any;
      if (String(path).includes('model-connections'))
        return {
          connections: [
            {
              id: 'native',
              provider: 'Native',
              apiType:
                harness === 'gemini'
                  ? 'google-generative-language'
                  : harness === 'claude'
                    ? 'anthropic-lb'
                    : 'openai-lb',
              enabled: true,
              codexEligible: true,
              claudeEligible: true,
              geminiEligible: true,
              models: [{ id: 'model' }],
            },
          ],
        };
      if (!init?.method && String(path).endsWith('/minion-settings'))
        return { ...result, [`${harness}Model`]: pair };
      return result;
    });
    render(<MinionSettings agentId="agent" />);
    const toggle = await screen.findByLabelText(`Lock ${label} model`);
    expect(toggle).toHaveProperty('checked', false);
    fireEvent.click(toggle);
    fireEvent.click(screen.getByText('Save minion defaults'));
    await waitFor(() => expect(body()).toEqual({ [`${harness}ModelLocked`]: true }));
    await waitFor(() =>
      expect(screen.getByText('Save minion defaults')).toHaveProperty('disabled', true),
    );
    fireEvent.change(screen.getByLabelText(`${label} provider`), { target: { value: '' } });
    fireEvent.click(screen.getByText('Save minion defaults'));
    await waitFor(() =>
      expect(body(1)).toEqual({ [`${harness}Model`]: null, [`${harness}ModelLocked`]: false }),
    );
  });
}
it('shows inherited locks read-only and restores saved override lock values', async () => {
  setup();
  const original = vi.mocked(api).getMockImplementation()!;
  vi.mocked(api).mockImplementation(async (path, init) => {
    const result = (await original(path, init)) as any;
    return String(path).endsWith('/minion-settings')
      ? {
          ...result,
          codexModelLocked: false,
          effective: { ...defaults, codexModel: pair, codexModelLocked: true },
        }
      : result;
  });
  render(<MinionSettings agentId="agent" />);
  const toggle = await screen.findByLabelText('Lock Codex model');
  expect(toggle).toHaveProperty('checked', true);
  expect(toggle.closest('fieldset')?.disabled).toBe(true);
  fireEvent.click(screen.getByLabelText('Override global minion settings'));
  await waitFor(() => expect(toggle).toHaveProperty('checked', false));
  expect(body()).toEqual({ overrideEnabled: true });
});
it('allows unlocking unavailable saved models but not relocking them', async () => {
  setup(true);
  const original = vi.mocked(api).getMockImplementation()!;
  vi.mocked(api).mockImplementation(async (path, init) => {
    const result = (await original(path, init)) as any;
    if (String(path).includes('model-connections')) return { connections: [] } as never;
    return !init?.method ? { ...result, codexModelLocked: true } : result;
  });
  render(<MinionSettings />);
  const toggle = await screen.findByLabelText('Lock Codex model');
  fireEvent.click(toggle);
  expect(toggle).toHaveProperty('disabled', true);
  fireEvent.click(screen.getByText('Save minion defaults'));
  await waitFor(() => expect(body()).toEqual({ codexModelLocked: false }));
});
it('retains lock draft on rejected acknowledgement and retries only that field', async () => {
  setup(true);
  render(<MinionSettings />);
  fireEvent.click(await screen.findByLabelText('Lock Codex model'));
  vi.mocked(api).mockRejectedValueOnce(new Error('offline'));
  fireEvent.click(screen.getByText('Save minion defaults'));
  await screen.findByRole('alert');
  expect(screen.getByLabelText('Lock Codex model')).toHaveProperty('checked', true);
  fireEvent.click(screen.getByText('Save minion defaults'));
  await waitFor(() => expect(body(1)).toEqual({ codexModelLocked: true }));
});

for (const agentId of [undefined, 'agent']) {
  it(`rejects an omitted lock acknowledgement from an older ${agentId ? 'agent' : 'global'} backend and retains the draft for retry`, async () => {
    setup(true);
    const original = vi.mocked(api).getMockImplementation()!;
    let legacy = true;
    vi.mocked(api).mockImplementation(async (path, init) => {
      const result = await original(path, init);
      if (legacy && String(path).endsWith('/minion-settings')) {
        const { codexModelLocked: _ignored, ...withoutLock } = result as any;
        return withoutLock;
      }
      return result;
    });
    render(<MinionSettings agentId={agentId} />);
    const toggle = await screen.findByLabelText('Lock Codex model');
    expect(toggle).toHaveProperty('checked', false);
    fireEvent.click(toggle);
    fireEvent.click(screen.getByText('Save minion defaults'));
    await screen.findByText(/Minion settings were not acknowledged/);
    expect(body()).toEqual({ codexModelLocked: true });
    expect(toggle).toHaveProperty('checked', true);
    expect(screen.getByText('Save minion defaults')).toHaveProperty('disabled', false);
    legacy = false;
    fireEvent.click(screen.getByText('Save minion defaults'));
    await waitFor(() =>
      expect(screen.getByText('Save minion defaults')).toHaveProperty('disabled', true),
    );
    expect(body(1)).toEqual({ codexModelLocked: true });
    expect(screen.queryByRole('alert')).toBeNull();
  });
}
