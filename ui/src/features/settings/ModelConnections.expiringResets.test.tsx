import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../../app/api';
import { UnsavedChangesProvider } from '../../app/UnsavedChanges';
import type { SavedProvider } from '../../app/types';
import { ModelConnections } from './ModelConnections';

vi.mock('../../app/api', async (original) => ({
  ...(await original<typeof import('../../app/api')>()),
  api: vi.fn(),
}));
vi.mock('../../app/ConfirmDialog', () => ({ useConfirm: () => async () => true }));
afterEach(() => {
  cleanup();
  vi.mocked(api).mockReset();
});
const label = 'Automatically use expiring resets';
const oauth: SavedProvider = {
  id: 'oauth',
  provider: 'Personal ChatGPT',
  apiType: 'openai-responses',
  url: 'https://chatgpt.com/backend-api',
  apiKey: '',
  models: ['gpt-test'],
  auth: { type: 'oauth', provider: 'openai', source: 'openai-oauth' },
};
function mount(
  provider = oauth,
  loadBalancing = false,
  refresh = vi.fn().mockResolvedValue(undefined),
  expand = true,
) {
  render(
    <UnsavedChangesProvider>
      <ModelConnections
        savedProviders={[provider]}
        loadBalancing={loadBalancing}
        onModelConnectionsChanged={refresh}
        mcpConnections={null}
        overflowTarget={null}
      />
    </UnsavedChangesProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${provider.provider}`) }));
  if (expand && !loadBalancing)
    fireEvent.click(screen.getByRole('button', { name: 'Edit connection' }));
}
const toggle = () => screen.getByRole('checkbox', { name: label }) as HTMLInputElement;
const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save' }));

it('shares connection disclosure, defaults off, and retains the mounted draft across hide/reopen', () => {
  mount(oauth, false, undefined, false);
  const fields = document.getElementById('models-connection-fields')!;
  const hiddenToggle = screen.getByLabelText(label) as HTMLInputElement;
  expect(fields.hidden).toBe(true);
  expect(fields.contains(hiddenToggle)).toBe(true);
  expect(screen.queryByRole('checkbox', { name: label })).toBeNull();
  expect(screen.queryByText(/Uses banked reset credits/)?.closest('[hidden]')).toBe(fields);
  expect(screen.queryByRole('textbox', { name: 'Provider' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Edit connection' }));
  expect(toggle()).toBe(hiddenToggle);
  expect(toggle().checked).toBe(false);
  const description = document.getElementById(toggle().getAttribute('aria-describedby')!);
  expect(description?.textContent).toMatch(/banked reset credits within 5 minutes of expiry/);
  expect(description?.textContent).toMatch(/backend even\s+when your browser is closed/);
  expect(description?.textContent).toMatch(/Manual resets stay available/);
  fireEvent.click(toggle());
  fireEvent.click(screen.getByRole('button', { name: 'Hide connection' }));
  expect(screen.queryByRole('checkbox', { name: label })).toBeNull();
  expect(screen.queryByRole('textbox', { name: 'Provider' })).toBeNull();
  expect(
    screen.getByRole('button', { name: 'Edit connection' }).getAttribute('aria-expanded'),
  ).toBe('false');
  expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Select gpt-test' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Edit connection' }));
  expect(toggle()).toBe(hiddenToggle);
  expect(toggle().checked).toBe(true);
  expect(api).not.toHaveBeenCalled();
});

it('uses recovery disclosure then hides with sibling fields after successful discovery', async () => {
  vi.mocked(api).mockRejectedValueOnce(new Error('Fixture discovery failure'));
  mount(oauth, false, undefined, false);
  expect(screen.queryByRole('checkbox', { name: label })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
  await screen.findByRole('alert');
  expect(toggle().closest('[hidden]')).toBeNull();
  expect(
    (screen.getByRole('button', { name: 'Hide connection' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  vi.mocked(api).mockResolvedValueOnce({ models: [{ id: 'gpt-test', selected: true }] });
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
  await waitFor(() => expect(screen.queryByRole('checkbox', { name: label })).toBeNull());
  expect(screen.queryByRole('textbox', { name: 'Provider' })).toBeNull();
});

it('resets disclosure on switching saved accounts without leaking the previous account value', () => {
  const second = { ...oauth, id: 'second', provider: 'Work ChatGPT', autoUseExpiringResets: true };
  render(
    <ModelConnections
      savedProviders={[oauth, second]}
      onModelConnectionsChanged={async () => {}}
      mcpConnections={null}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: /^Personal ChatGPT/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Edit connection' }));
  expect(toggle().checked).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: /^Work ChatGPT/ }));
  expect(screen.queryByRole('checkbox', { name: label })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Edit connection' }));
  expect(toggle().checked).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Add provider' }));
  expect(screen.queryByRole('checkbox', { name: label })).toBeNull();
});

it.each([true, false])(
  'saves explicit %s through the existing connection endpoint',
  async (enabled) => {
    vi.mocked(api).mockResolvedValue({});
    mount({ ...oauth, autoUseExpiringResets: !enabled });
    expect(toggle().checked).toBe(!enabled);
    fireEvent.click(toggle());
    save();
    await waitFor(() => expect(api).toHaveBeenCalledTimes(1));
    const [path, init] = vi.mocked(api).mock.calls[0];
    expect(path).toBe('/api/settings/model-connections');
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      id: 'oauth',
      apiType: 'openai-responses',
      autoUseExpiringResets: enabled,
    });
    expect(body.oauthTokens).toBeUndefined();
  },
);

it.each([
  { ...oauth, id: 'api', auth: undefined },
  {
    ...oauth,
    id: 'claude',
    apiType: 'anthropic-messages',
    auth: { type: 'oauth', provider: 'anthropic' },
  },
  { ...oauth, id: 'chat', apiType: 'openai-chat-completions' },
])('does not expose or send automatic resets for $id', async (provider) => {
  vi.mocked(api).mockResolvedValue({});
  mount(provider);
  expect(screen.queryByRole('checkbox', { name: label })).toBeNull();
  save();
  await waitFor(() => expect(api).toHaveBeenCalledTimes(1));
  expect(JSON.parse(String(vi.mocked(api).mock.calls[0][1]?.body))).not.toHaveProperty(
    'autoUseExpiringResets',
  );
});

it('does not expose or send automatic resets for a load balancing pool', async () => {
  vi.mocked(api).mockResolvedValue({});
  mount(
    {
      ...oauth,
      id: 'pool',
      apiType: 'openai-lb',
      pool: { enabled: true, memberConnectionIds: [], sticky: true },
    },
    true,
  );
  expect(screen.queryByRole('checkbox', { name: label })).toBeNull();
});

it('retains a changed value after save failure and retries only the settings write', async () => {
  vi.mocked(api).mockRejectedValueOnce(new Error('Fixture save failure')).mockResolvedValue({});
  mount();
  fireEvent.click(toggle());
  save();
  await screen.findByRole('alert');
  expect(toggle().checked).toBe(true);
  expect(toggle().disabled).toBe(false);
  save();
  await waitFor(() => expect(api).toHaveBeenCalledTimes(2));
  expect(
    vi.mocked(api).mock.calls.every(([path]) => path === '/api/settings/model-connections'),
  ).toBe(true);
});

it('tracks toggle-only edits and Cancel uses the shared unsaved changes guard', async () => {
  mount({ ...oauth, autoUseExpiringResets: true });
  expect(screen.queryByRole('alertdialog')).toBeNull();
  fireEvent.click(toggle());
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(await screen.findByRole('alertdialog')).toBeTruthy();
  expect(toggle().checked).toBe(false);
  expect(api).not.toHaveBeenCalled();
});

it('locks the toggle while the settings write and refresh are pending', async () => {
  let finish!: () => void;
  vi.mocked(api).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = () => resolve({});
      }),
  );
  mount();
  fireEvent.click(toggle());
  save();
  expect(toggle().disabled).toBe(true);
  finish();
  await waitFor(() => expect(screen.queryByRole('checkbox', { name: label })).toBeNull());
});
