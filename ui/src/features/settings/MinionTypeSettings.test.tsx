import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../app/api';
import { UnsavedChangesProvider, useUnsavedChanges } from '../../app/UnsavedChanges';
import { MinionTypeSettings } from './MinionTypeSettings';
import { DefaultMinionModel } from './DefaultMinionModel';

vi.mock('../../app/api', async (original) => ({
  ...(await original<typeof import('../../app/api')>()),
  api: vi.fn(),
}));
const mock = vi.mocked(api);
afterEach(() => {
  cleanup();
  mock.mockReset();
});
const select = () =>
  screen.getByRole('combobox', { name: 'Default minion type' }) as HTMLSelectElement;
const renderSettings = (id = 'agent') =>
  render(
    <UnsavedChangesProvider>
      <MinionTypeSettings resourceId={id}>
        <DefaultMinionModel resourceId={id} savedProviders={[]} />
      </MinionTypeSettings>
    </UnsavedChangesProvider>,
  );
const setup = (harness?: string) => {
  let saved = harness;
  mock.mockImplementation(async (path, init) => {
    if (path.endsWith('/minion-model-selection')) return { ok: true, selection: null };
    if (init?.method === 'PUT') saved = JSON.parse(String(init.body)).defaultHarness;
    return { ok: true, maxDepth: 2, ...(saved !== undefined ? { defaultHarness: saved } : {}) };
  });
};

describe('default minion type', () => {
  it('reads legacy as Burrow, writes only harness, hides Codex-inapplicable controls after acknowledgement, restores saved model on switch back', async () => {
    setup();
    renderSettings();
    await screen.findByLabelText('Default minion provider');
    expect(select().value).toBe('burrow');
    fireEvent.change(select(), { target: { value: 'codex' } });
    await screen.findByText('Default minion type saved.');
    expect(screen.queryByLabelText('Default minion provider')).toBeNull();
    expect(
      JSON.parse(String(mock.mock.calls.find(([, init]) => init?.method === 'PUT')![1]?.body)),
    ).toEqual({ defaultHarness: 'codex' });
    expect(
      mock.mock.calls.filter(
        ([path, init]) => path.endsWith('minion-model-selection') && init?.method === 'PUT',
      ),
    ).toHaveLength(0);
    fireEvent.change(select(), { target: { value: 'burrow' } });
    await screen.findByLabelText('Default minion provider');
  });

  it.each([
    { ok: true, maxDepth: 1 },
    { ok: true, defaultHarness: 'burrow' },
    { ok: false, defaultHarness: 'codex' },
    null,
  ])('rejects unacknowledged writes and keeps saved Burrow editor (%j)', async (response) => {
    setup('burrow');
    renderSettings();
    await screen.findByLabelText('Default minion provider');
    mock.mockResolvedValueOnce(response);
    fireEvent.change(select(), { target: { value: 'codex' } });
    await screen.findByRole('alert');
    expect(select().value).toBe('codex');
    expect(screen.getByLabelText('Default minion provider')).toBeTruthy();
    expect(screen.queryByText('Default minion type saved.')).toBeNull();
    mock.mockResolvedValueOnce({ ok: true, defaultHarness: 'codex' });
    fireEvent.click(screen.getByRole('button', { name: 'Retry saving minion type' }));
    await screen.findByText('Default minion type saved.');
    expect(screen.queryByLabelText('Default minion provider')).toBeNull();
  });

  it('disables during save, does not hide editor before ack, ignores late completion on another owner', async () => {
    setup('burrow');
    const view = renderSettings('first');
    await screen.findByLabelText('Default minion provider');
    let resolve!: (value: unknown) => void;
    mock.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    fireEvent.change(select(), { target: { value: 'codex' } });
    expect(select().disabled).toBe(true);
    expect(screen.getByLabelText('Default minion provider')).toBeTruthy();
    view.rerender(
      <UnsavedChangesProvider>
        <MinionTypeSettings resourceId="second">
          <span>Burrow editor</span>
        </MinionTypeSettings>
      </UnsavedChangesProvider>,
    );
    await waitFor(() => expect(select().disabled).toBe(false));
    await act(async () => resolve({ ok: true, defaultHarness: 'codex' }));
    expect(select().value).toBe('burrow');
    expect(screen.queryByText('Default minion type saved.')).toBeNull();
  });

  it.each([null, { ok: true, defaultHarness: 'other' }, { ok: false }])(
    'fails closed on invalid reads and retries (%j)',
    async (response) => {
      mock.mockResolvedValueOnce(response);
      renderSettings();
      await screen.findByRole('alert');
      expect(select().disabled).toBe(true);
      expect(screen.queryByLabelText('Default minion provider')).toBeNull();
      setup('codex');
      fireEvent.click(screen.getByRole('button', { name: 'Retry minion type' }));
      await waitFor(() => expect(select().disabled).toBe(false));
      expect(select().value).toBe('codex');
    },
  );

  it('guards failed Burrow drafts before removing that editor', async () => {
    function FailedDraft() {
      useUnsavedChanges({ dirty: true, busy: false, save: async () => false, discard: vi.fn() });
      return <span>Failed model draft</span>;
    }
    setup('burrow');
    render(
      <UnsavedChangesProvider>
        <MinionTypeSettings resourceId="agent">
          <FailedDraft />
        </MinionTypeSettings>
      </UnsavedChangesProvider>,
    );
    await screen.findByText('Failed model draft');
    fireEvent.change(select(), { target: { value: 'codex' } });
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(mock.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Stay' }));
    expect(select().value).toBe('burrow');
    fireEvent.change(select(), { target: { value: 'codex' } });
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    await screen.findByText('Default minion type saved.');
    expect(screen.queryByText('Failed model draft')).toBeNull();
  });
});
