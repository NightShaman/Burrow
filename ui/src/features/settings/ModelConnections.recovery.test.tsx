import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
const models = [
  { id: 'general', selected: true },
  { id: 'vision', selected: true },
];
const providers: SavedProvider[] = [
  {
    id: 'first',
    provider: 'First provider',
    apiType: 'openai-responses',
    url: 'https://first.invalid',
    apiKey: '',
    models: ['general', 'vision'],
    connectionModels: models,
  },
  {
    id: 'second',
    provider: 'Second provider',
    apiType: 'openai-responses',
    url: 'https://second.invalid',
    apiKey: '',
    models: ['other'],
  },
];
function mount() {
  render(
    <ModelConnections
      savedProviders={providers}
      onModelConnectionsChanged={async () => {}}
      mcpConnections={null}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: /First provider.*2 models/ }));
}
function collapsed() {
  expect(document.getElementById('models-connection-fields')?.hidden).toBe(true);
  expect(screen.queryByRole('textbox', { name: 'Provider' })).toBeNull();
  expect(
    screen.getByRole('button', { name: 'Edit connection' }).getAttribute('aria-expanded'),
  ).toBe('false');
}
function recovery() {
  expect(document.getElementById('models-connection-fields')?.hidden).toBe(false);
  expect(screen.getByRole('textbox', { name: 'Provider' })).toBeTruthy();
  const hide = screen.getByRole('button', { name: 'Hide connection' }) as HTMLButtonElement;
  expect(hide.disabled).toBe(true);
  expect(hide.getAttribute('aria-expanded')).toBe('true');
  expect(hide.title).toMatch(/retry|connect|switch/i);
  fireEvent.click(hide);
  expect(document.getElementById('models-connection-fields')?.hidden).toBe(false);
}
async function fail() {
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
  await screen.findByRole('alert');
  recovery();
}
function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

it.each(['http', 'network', 'envelope'] as const)(
  'opens a collapsed saved connection for %s discovery failures without matching message text',
  async (kind) => {
    if (kind === 'envelope')
      vi.mocked(api).mockResolvedValue({
        models,
        discovery: { status: 'error', error: 'Generic failure' },
      });
    else
      vi.mocked(api).mockRejectedValue(
        kind === 'http'
          ? Object.assign(new Error('Generic failure'), { status: 401 })
          : new TypeError('Generic failure'),
      );
    mount();
    collapsed();
    fireEvent.click(screen.getByRole('button', { name: 'Select vision' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Use vision' }));
    await fail();
    expect(screen.getByRole('heading', { name: 'vision' })).toBeTruthy();
    expect((screen.getByRole('checkbox', { name: 'Use vision' }) as HTMLInputElement).checked).toBe(
      false,
    );
    expect((screen.getByLabelText('URL') as HTMLInputElement).value).toBe('https://first.invalid');
    expect((screen.getByLabelText('API key') as HTMLInputElement).value).toBe('');
    expect(screen.getByRole('alert').closest('[hidden]')).toBeNull();
    fireEvent.change(screen.getByLabelText('Model ID'), { target: { value: 'manual-fallback' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add model' }));
    expect(screen.getByRole('button', { name: 'Select manual-fallback' })).toBeTruthy();
    recovery();
  },
);

it('keeps credential drafts and recovery disclosure through pending and repeated retries, then clears on success', async () => {
  vi.mocked(api).mockRejectedValueOnce(new Error('Generic failure'));
  mount();
  await fail();
  fireEvent.change(screen.getByLabelText('API key'), {
    target: { value: 'synthetic-replacement' },
  });
  const pending = deferred();
  vi.mocked(api).mockImplementationOnce(() => pending.promise as ReturnType<typeof api>);
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
  recovery();
  expect((screen.getByRole('button', { name: 'Connecting…' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByLabelText('API key') as HTMLInputElement).value).toBe(
    'synthetic-replacement',
  );
  await act(async () => pending.reject(new Error('Again')));
  await screen.findByRole('alert');
  recovery();
  vi.mocked(api).mockResolvedValueOnce({ models });
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
  await waitFor(collapsed);
  expect(screen.queryByRole('alert')).toBeNull();
  const request = JSON.parse(String(vi.mocked(api).mock.calls.at(-1)?.[1]?.body));
  expect(request.apiKey).toBe('synthetic-replacement');
});

it('allows keyless discovery and does not expand successful saved connections', async () => {
  vi.mocked(api).mockResolvedValue({ models });
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
  await waitFor(() => expect(vi.mocked(api)).toHaveBeenCalledTimes(1));
  await waitFor(() =>
    expect((screen.getByRole('button', { name: 'Connect' }) as HTMLButtonElement).disabled).toBe(
      false,
    ),
  );
  collapsed();
  expect(JSON.parse(String(vi.mocked(api).mock.calls[0][1]?.body)).apiKey).toBe('');
});

it.each(['switch', 'reset'] as const)(
  'clears recovery on %s and ignores an old failed retry completion',
  async (destination) => {
    vi.mocked(api).mockRejectedValueOnce(new Error('Initial failure'));
    mount();
    await fail();
    const pending = deferred();
    vi.mocked(api).mockImplementationOnce(() => pending.promise as ReturnType<typeof api>);
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    fireEvent.click(
      screen.getByRole('button', {
        name: destination === 'switch' ? /Second provider.*1 model/ : 'Add provider',
      }),
    );
    if (destination === 'switch') collapsed();
    else expect((screen.getByLabelText('Provider') as HTMLInputElement).value).toBe('');
    await act(async () => pending.reject(new Error('Stale failure')));
    expect(screen.queryByRole('alert')).toBeNull();
    if (destination === 'switch') collapsed();
    else {
      fireEvent.click(screen.getByRole('button', { name: /First provider.*2 models/ }));
      collapsed();
    }
  },
);

it('does not reopen a collapsed connection for an unrelated failed Save', async () => {
  vi.mocked(api).mockRejectedValue(new Error('Generic failure'));
  mount();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Use vision' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByRole('alert');
  collapsed();
});

it('does not expand for failed Delete or provider-list refresh after Save', async () => {
  vi.mocked(api).mockRejectedValueOnce(new Error('Delete unavailable'));
  render(
    <ModelConnections
      savedProviders={providers}
      onModelConnectionsChanged={async () => {
        throw new Error('Refresh unavailable');
      }}
      mcpConnections={null}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: /First provider.*2 models/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Delete First provider' }));
  await screen.findByRole('alert');
  collapsed();
  vi.mocked(api).mockResolvedValueOnce({});
  fireEvent.click(screen.getByRole('checkbox', { name: 'Use vision' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('refresh failed'));
  collapsed();
});

it('preserves recovery on Stay and clears it after explicit Discard navigation', async () => {
  vi.mocked(api).mockRejectedValue(new Error('Discovery unavailable'));
  render(
    <UnsavedChangesProvider>
      <ModelConnections
        savedProviders={providers}
        onModelConnectionsChanged={async () => {}}
        mcpConnections={null}
      />
    </UnsavedChangesProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: /First provider.*2 models/ }));
  await fail();
  fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'synthetic-draft' } });
  fireEvent.click(screen.getByRole('button', { name: /Second provider.*1 model/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Stay' }));
  recovery();
  expect((screen.getByLabelText('API key') as HTMLInputElement).value).toBe('synthetic-draft');
  fireEvent.click(screen.getByRole('button', { name: /Second provider.*1 model/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
  collapsed();
  fireEvent.click(screen.getByRole('button', { name: /First provider.*2 models/ }));
  collapsed();
});

it('ignores successful stale discovery after switching providers', async () => {
  const pending = deferred();
  vi.mocked(api).mockImplementationOnce(() => pending.promise as ReturnType<typeof api>);
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
  fireEvent.click(screen.getByRole('button', { name: /Second provider.*1 model/ }));
  await act(async () => pending.resolve({ models: [{ id: 'stale-model', selected: true }] }));
  collapsed();
  expect(screen.getByRole('button', { name: 'Select other' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Select stale-model' })).toBeNull();
});

it('reveals masked replacement tokens and sign-in shortcuts after saved OAuth discovery fails', async () => {
  vi.mocked(api).mockRejectedValue(new Error('Generic failure'));
  const oauth: SavedProvider = { ...providers[0], auth: { provider: 'OpenAI' } };
  render(
    <ModelConnections
      savedProviders={[oauth]}
      onModelConnectionsChanged={async () => {}}
      mcpConnections={null}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: /First provider.*2 models/ }));
  collapsed();
  await fail();
  for (const label of ['OpenAI ID token', 'OpenAI access token', 'OpenAI refresh token']) {
    const input = screen.getByLabelText(label) as HTMLInputElement;
    expect(input.type).toBe('password');
    expect(input.autocomplete).toBe('off');
    expect(input.closest('[hidden]')).toBeNull();
    fireEvent.change(input, { target: { value: 'synthetic-replacement' } });
    expect(input.value).toBe('synthetic-replacement');
  }
  expect(screen.getByRole('button', { name: /OpenAI OAuth.*Sign in with ChatGPT/ })).toBeTruthy();
  expect(screen.getByRole('button', { name: /Anthropic OAuth.*Claude Code login/ })).toBeTruthy();
  expect((screen.getByLabelText('API key') as HTMLInputElement).type).toBe('password');
  recovery();
});
