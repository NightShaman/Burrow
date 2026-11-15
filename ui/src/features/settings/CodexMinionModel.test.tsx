import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../../app/api';
import { UnsavedChangesProvider } from '../../app/UnsavedChanges';
import { MinionTypeSettings } from './MinionTypeSettings';

vi.mock('../../app/api', async (original) => ({
  ...(await original<typeof import('../../app/api')>()),
  api: vi.fn(),
}));
const mock = vi.mocked(api);
afterEach(() => {
  cleanup();
  mock.mockReset();
});
const account = (id = 'a', extra = {}) => ({
  id,
  provider: `Account ${id}`,
  apiType: 'openai-responses',
  auth: { type: 'oauth', provider: 'OpenAI' },
  models: [
    { id: `${id}-model`, displayName: `${id} model` },
    { id: 'disabled', selected: false },
  ],
  ...extra,
});
function setup(codexModel: unknown = null, connections = [account()]) {
  let saved = { ok: true, defaultHarness: 'codex', maxDepth: 2, codexModel };
  mock.mockImplementation(async (path, init) => {
    if (path === '/api/settings/model-connections') return { ok: true, connections };
    if (init?.method === 'PUT') saved = { ...saved, ...JSON.parse(String(init.body)) };
    return saved;
  });
}
function mount(id = 'agent') {
  return render(
    <UnsavedChangesProvider>
      <MinionTypeSettings resourceId={id}>
        <span>Burrow controls</span>
      </MinionTypeSettings>
    </UnsavedChangesProvider>,
  );
}
const control = (name: string) => screen.getByRole('combobox', { name }) as HTMLSelectElement;
const loaded = () => waitFor(() => expect(control('Account').disabled).toBe(false));
const writes = () =>
  mock.mock.calls
    .filter(([, init]) => init?.method === 'PUT')
    .map(([, init]) => JSON.parse(String(init?.body)));

it('shows saved account/model and filters direct OAuth accounts and enabled models independently of parent pools', async () => {
  setup({ connectionId: 'a', model: 'a-model' }, [
    account(),
    account('b', {
      apiType: 'openai-chat-completions',
      auth: { type: 'OAUTH', provider: 'OPENAI' },
    }),
    account('pool', { apiType: 'openai-lb' }),
    account('key', { auth: { type: 'api_key', provider: 'openai' } }),
    account('other', { auth: { type: 'oauth', provider: 'anthropic' } }),
    account('missing', { auth: { type: 'oauth' } }),
  ]);
  mount();
  await loaded();
  expect(control('Account').value).toBe('a');
  expect(control('Model').value).toBe('a-model');
  expect(Array.from(control('Account').options).map((option) => option.value)).toEqual([
    '',
    'a',
    'b',
  ]);
  expect(Array.from(control('Model').options).map((option) => option.value)).toEqual([
    '',
    'a-model',
  ]);
  expect(writes()).toEqual([]);
});

it.each([
  { connectionId: 'removed', model: 'old' },
  { connectionId: 'a', model: 'disabled' },
])('keeps unavailable saved selection visible: %j', async (selection) => {
  setup(selection);
  mount();
  await loaded();
  expect(control('Account').value).toBe(selection.connectionId);
  expect(control('Model').value).toBe(selection.model);
  expect(screen.getByText(/selected account or model is unavailable/)).toBeTruthy();
  expect(writes()).toEqual([]);
});

it('changes account with its compatible model, clears with null, and omits Codex settings on harness writes', async () => {
  setup({ connectionId: 'a', model: 'a-model' }, [account(), account('b')]);
  mount();
  await loaded();
  fireEvent.change(control('Account'), { target: { value: 'b' } });
  await screen.findByText('Codex model saved.');
  expect(control('Model').value).toBe('b-model');
  expect(writes()).toEqual([{ codexModel: { connectionId: 'b', model: 'b-model' } }]);
  fireEvent.change(control('Account'), { target: { value: '' } });
  await waitFor(() => expect(writes()).toHaveLength(2));
  await loaded();
  expect(writes()[1]).toEqual({ codexModel: null });
  fireEvent.change(control('Default minion type'), { target: { value: 'burrow' } });
  await screen.findByText('Burrow controls');
  expect(writes()[2]).toEqual({ defaultHarness: 'burrow' });
  fireEvent.change(control('Default minion type'), { target: { value: 'codex' } });
  await loaded();
  expect(control('Account').value).toBe('');
});

it('does not retain an old model for an account with no enabled models or send an incomplete pair', async () => {
  setup({ connectionId: 'a', model: 'a-model' }, [account(), account('empty', { models: [] })]);
  mount();
  await loaded();
  fireEvent.change(control('Account'), { target: { value: 'empty' } });
  expect(control('Model').value).toBe('');
  expect(writes()).toEqual([]);
  fireEvent.change(control('Default minion type'), { target: { value: 'burrow' } });
  expect(screen.getByRole('alertdialog')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Stay' }));
  expect(control('Account').value).toBe('empty');
});

it('retains failed drafts, shows actionable save errors, retries, and guards navigation', async () => {
  setup();
  mount();
  await loaded();
  mock.mockRejectedValueOnce(new Error('Enable/select a model on that connection.'));
  fireEvent.change(control('Account'), { target: { value: 'a' } });
  await screen.findByRole('alert');
  expect(screen.getByRole('alert').textContent).toContain('Enable/select a model');
  expect(control('Model').value).toBe('a-model');
  fireEvent.change(control('Default minion type'), { target: { value: 'burrow' } });
  expect(screen.getByRole('alertdialog')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Stay' }));
  fireEvent.click(screen.getByRole('button', { name: 'Retry saving Codex model' }));
  await screen.findByText('Codex model saved.');
});

it.each([
  {},
  { ok: true, codexModel: null },
  { ok: true, codexModel: { connectionId: 'b', model: 'b-model' } },
])('rejects mismatched or missing save acknowledgement: %j', async (result) => {
  setup();
  mount();
  await loaded();
  mock.mockResolvedValueOnce(result);
  fireEvent.change(control('Account'), { target: { value: 'a' } });
  await screen.findByRole('alert');
  expect(control('Account').value).toBe('a');
  expect(screen.queryByText('Codex model saved.')).toBeNull();
});

it('shows loading, empty and catalog errors with retry', async () => {
  setup(null, []);
  let reject!: (cause: Error) => void;
  const implementation = mock.getMockImplementation()!;
  mock.mockImplementation((path, init, options) =>
    path === '/api/settings/model-connections'
      ? new Promise((_, fail) => {
          reject = fail;
        })
      : implementation(path, init, options),
  );
  mount();
  await screen.findByText('Loading Codex model…');
  expect(control('Account').disabled).toBe(true);
  await act(async () => reject(new Error('Catalog unavailable')));
  expect(screen.getByRole('alert').textContent).toContain('Catalog unavailable');
  setup(null, []);
  fireEvent.click(screen.getByRole('button', { name: 'Retry Codex model' }));
  await loaded();
  expect(screen.getByText('Connect a direct OpenAI OAuth account in Models.')).toBeTruthy();
});

it('ignores a late save after changing agent', async () => {
  setup();
  const view = mount();
  await loaded();
  let resolve!: (result: unknown) => void;
  mock.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  fireEvent.change(control('Account'), { target: { value: 'a' } });
  expect(control('Account').disabled).toBe(true);
  view.rerender(
    <UnsavedChangesProvider>
      <MinionTypeSettings resourceId="second">
        <span>Burrow controls</span>
      </MinionTypeSettings>
    </UnsavedChangesProvider>,
  );
  await loaded();
  await act(async () => resolve({ ok: true, codexModel: { connectionId: 'a', model: 'a-model' } }));
  expect(control('Account').value).toBe('');
  expect(screen.queryByText('Codex model saved.')).toBeNull();
});

it('saves an enabled model change and preserves the pair through Burrow and back', async () => {
  setup({ connectionId: 'a', model: 'a-model' }, [
    account('a', { models: [{ id: 'a-model' }, { id: 'second' }] }),
  ]);
  mount();
  await loaded();
  fireEvent.change(control('Model'), { target: { value: 'second' } });
  await screen.findByText('Codex model saved.');
  expect(writes()).toEqual([{ codexModel: { connectionId: 'a', model: 'second' } }]);
  fireEvent.change(control('Default minion type'), { target: { value: 'burrow' } });
  await screen.findByText('Burrow controls');
  fireEvent.change(control('Default minion type'), { target: { value: 'codex' } });
  await loaded();
  expect(control('Account').value).toBe('a');
  expect(control('Model').value).toBe('second');
  expect(writes().slice(1)).toEqual([{ defaultHarness: 'burrow' }, { defaultHarness: 'codex' }]);
});

it('fails closed on a malformed saved pair and retries settings reads', async () => {
  setup({ connectionId: 'a' });
  mount();
  await screen.findByRole('alert');
  expect(control('Account').disabled).toBe(true);
  expect(writes()).toEqual([]);
  setup({ connectionId: 'a', model: 'a-model' });
  fireEvent.click(screen.getByRole('button', { name: 'Retry Codex model' }));
  await loaded();
  expect(control('Model').value).toBe('a-model');
});
