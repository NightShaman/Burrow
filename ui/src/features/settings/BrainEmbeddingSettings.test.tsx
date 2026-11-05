import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrainEmbeddingSettings } from './BrainEmbeddingSettings';
import { api } from '../../app/api';
import { UnsavedChangesProvider, useUnsavedNavigation } from '../../app/UnsavedChanges';
import type { SavedProvider } from '../../app/types';
vi.mock('../../app/api', () => ({ api: vi.fn() }));
const mocked = vi.mocked(api);
const status = {
  enabled: false,
  connectionId: null,
  model: null,
  generation: '9007199254740993',
  total: '9007199254740995',
  indexed: '2',
  pending: '3',
  failed: '1',
  storage: 'postgres_float8_exact_cosine',
  lastError: 'brain_embedding_index_failed',
};
const providers = ['a', 'b', 'OpenAI', 'Azure OpenAI'].map((id) => ({
  id,
  provider: id,
  apiType: id === 'OpenAI' ? 'openai-responses' : id === 'Azure OpenAI' ? 'azure-openai' : 'ollama',
  url: '',
  apiKey: '',
  models: ['chat-only'],
})) as SavedProvider[];
const conversationStatus = {
  enabled: true,
  total: 120,
  indexed: 96,
  pending: 20,
  failed: 4,
  lastError: 'conversation_embedding_failed',
  storage: 'postgres_float8_exact_cosine',
  dimensions: 1536,
  generation: 'conversation-1',
  epoch: '1',
  backfillComplete: false,
  dirty: 1,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const discover = (connectionId: string) => ({
  connectionId,
  provider: 'ollama',
  models: [] as { id: string; name: string }[],
  capabilityDisclosure: 'No advertised capabilities',
});
beforeEach(() => {
  mocked.mockReset();
  mocked.mockImplementation(async (path) =>
    path.includes('/models')
      ? discover(new URL(path, 'http://test').searchParams.get('connectionId')!)
      : status,
  );
});
afterEach(cleanup);
async function mount() {
  render(<BrainEmbeddingSettings savedProviders={providers} />);
  await waitFor(() =>
    expect((screen.getByLabelText('Provider') as HTMLSelectElement).disabled).toBe(false),
  );
}
describe('Brain embedding settings', () => {
  it('keeps disabled defaults and exact string counts; disabling never needs consent', async () => {
    await mount();
    expect(screen.getByLabelText('Provider').parentElement?.parentElement).toBe(
      screen.getByLabelText('Model').parentElement?.parentElement,
    );
    expect(screen.getByRole('option', { name: 'a' })).toHaveProperty('value', 'a');
    expect(
      (screen.getByLabelText('Enable Brains embeddings globally') as HTMLInputElement).checked,
    ).toBe(false);
    expect(screen.getByText(/Indexed 2 \/ 9007199254740995/).textContent).toContain(
      'Generation 9007199254740993',
    );
    fireEvent.click(screen.getByText('Save embedding settings'));
    await waitFor(() =>
      expect(mocked).toHaveBeenCalledWith(
        '/api/settings/brain-embeddings',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({
            enabled: false,
            conversationEnabled: false,
            connectionId: null,
            model: null,
          }),
        }),
      ),
    );
  });
  it('uses embedding discovery, manual fallback without acknowledgment gates', async () => {
    await mount();
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'a' } });
    await screen.findByText(/No advertised capabilities/);
    expect(screen.queryByText('chat-only')).toBeNull();
    fireEvent.change(screen.getByLabelText('Embedding model or deployment ID (manual fallback)'), {
      target: { value: 'embed-manual' },
    });
    fireEvent.click(screen.getByLabelText('Enable Brains embeddings globally'));
    const test = screen.getByText('Test embedding model') as HTMLButtonElement;
    expect(test.disabled).toBe(false);
    expect(screen.queryByLabelText(/I confirm provider requests/)).toBeNull();
    expect(screen.queryByText(/Memories are explicit agent-owned records/)).toBeNull();
    expect((screen.getByText('Save embedding settings') as HTMLButtonElement).disabled).toBe(true);
    mocked.mockImplementation(async (path) =>
      path.endsWith('/test') ? { ok: true, dimensions: 768 } : status,
    );
    fireEvent.click(test);
    await screen.findByText('Test successful · 768 dimensions');
    expect(mocked).toHaveBeenCalledWith(
      '/api/settings/brain-embeddings/test',
      expect.objectContaining({
        body: JSON.stringify({ connectionId: 'a', model: 'embed-manual' }),
      }),
    );
    expect((screen.getByText('Save embedding settings') as HTMLButtonElement).disabled).toBe(false);
  });
  it('discards deferred discovery for a previous connection', async () => {
    const old = deferred<ReturnType<typeof discover>>();
    mocked.mockImplementation(async (path) =>
      path.includes('connectionId=a')
        ? old.promise
        : path.includes('/models')
          ? discover('b')
          : status,
    );
    await mount();
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'a' } });
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'b' } });
    await screen.findByText(/No advertised capabilities/);
    await act(async () =>
      old.resolve({ ...discover('a'), models: [{ id: 'stale', name: 'STALE MODEL' }] }),
    );
    expect(screen.queryByText('STALE MODEL')).toBeNull();
  });
  it('discards an old owner load after remount', async () => {
    const old = deferred<typeof status>();
    mocked.mockReturnValueOnce(old.promise);
    const view = render(<BrainEmbeddingSettings savedProviders={providers} />);
    view.unmount();
    await mount();
    await act(async () => old.resolve({ ...status, enabled: true }));
    expect(
      (screen.getByLabelText('Enable Brains embeddings globally') as HTMLInputElement).checked,
    ).toBe(false);
  });
  it('fences a deferred poll against save and the returned generation', async () => {
    const old = deferred<typeof status>();
    let reads = 0;
    mocked.mockImplementation(async (_path, options) =>
      _path === '/api/settings/brain-memory'
        ? { promoteDreamsToMemory: true }
        : options?.method === 'PUT'
          ? { ...status, generation: 'new', indexed: '7' }
          : ++reads === 2
            ? old.promise
            : {
                ...status,
                generation: reads > 2 ? 'new' : status.generation,
                indexed: reads > 2 ? '7' : '2',
              },
    );
    await mount();
    await waitFor(() => expect(reads).toBe(2));
    fireEvent.click(screen.getByText('Save embedding settings'));
    await screen.findByText(/Generation new/);
    await act(async () => old.resolve(status));
    expect(screen.getByText(/Generation new/).textContent).toContain('Indexed 7');
  });
  it('does not publish an old test after owner unmount', async () => {
    const old = deferred<{ ok: true; dimensions: number }>();
    mocked.mockImplementation(async (path) =>
      path.endsWith('/test') ? old.promise : path.includes('/models') ? discover('a') : status,
    );
    const view = render(<BrainEmbeddingSettings savedProviders={providers} />);
    await waitFor(() =>
      expect((screen.getByLabelText('Provider') as HTMLSelectElement).disabled).toBe(false),
    );
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'a' } });
    fireEvent.change(screen.getByLabelText('Embedding model or deployment ID (manual fallback)'), {
      target: { value: 'manual' },
    });
    fireEvent.click(screen.getByText('Test embedding model'));
    view.unmount();
    await mount();
    await act(async () => old.resolve({ ok: true, dimensions: 999 }));
    expect(screen.queryByText(/999 dimensions/)).toBeNull();
  });
});

describe('Session search preparation', () => {
  it('omits readiness for older responses rather than claiming history is ready', async () => {
    await mount();
    expect(screen.queryByText(/Session search (ready|preparing history)/)).toBeNull();
    expect(screen.getByText(/Partial coverage remains searchable lexically/)).toBeTruthy();
  });
  it.each([false, true])(
    'reports keyword readiness=%s with semantic indexing off',
    async (ready) => {
      mocked.mockResolvedValue({
        ...status,
        conversationEnabled: false,
        lexical: { ready, processed: 4268, stage: ready ? 'ready' : 'history', lastError: null },
      });
      await mount();
      expect(
        screen.getByText(
          ready
            ? 'Session search ready'
            : 'Session search preparing history · 4268 occurrences processed',
        ),
      ).toBeTruthy();
      const preparingHelp =
        /Session search becomes available when history preparation completes\. Embedding indexing continues in the background\./;
      if (ready) {
        expect(screen.getByText(/Partial coverage remains searchable lexically/)).toBeTruthy();
        expect(screen.queryByText(preparingHelp)).toBeNull();
      } else {
        expect(screen.getByText(preparingHelp)).toBeTruthy();
        expect(screen.queryByText(/Partial coverage remains searchable lexically/)).toBeNull();
      }
      expect(screen.getByLabelText('Index conversation history for session search')).toHaveProperty(
        'checked',
        false,
      );
    },
  );
  it('shows a scoped keyword preparation error independently of embedding errors', async () => {
    mocked.mockResolvedValue({
      ...status,
      lexical: {
        ready: false,
        processed: 0,
        stage: 'history',
        lastError: 'projection_unavailable',
      },
    });
    await mount();
    expect(
      screen.getByText('Session search preparation error: projection_unavailable'),
    ).toBeTruthy();
    expect(screen.getByText(/0 occurrences processed/)).toBeTruthy();
  });
});

describe('Conversation embedding settings', () => {
  const toggle = 'Index conversation history for session search';
  const manualLabel = 'Embedding model or deployment ID (manual fallback)';
  const root = '/api/settings/brain-embeddings';
  it('defaults conversation indexing off on old responses and exposes provider/history disclosure', async () => {
    await mount();
    expect(screen.getByLabelText(toggle)).toHaveProperty('checked', false);
    expect(screen.getByText(/Off by default, including upgrades/).textContent).toContain(
      'provider receives saved conversation passages',
    );
    expect(screen.getByText(/Session search retrieves original dialogue/).textContent).toContain(
      'embeddings help find it, not verify current facts or grant authorization',
    );
    expect(screen.getByText(/Conversations disabled/)).toBeTruthy();
    expect(screen.getByText('Reindex memories and conversations')).toHaveProperty('disabled', true);
  });
  it.each(['OpenAI', 'Azure OpenAI'])(
    'selects %s and saves a tested manual model/deployment with Brains off',
    async (connectionId) => {
      let saved = { ...status, conversationEnabled: false };
      mocked.mockImplementation(async (path, options) => {
        if (path.includes('/models')) return discover(connectionId);
        if (path.endsWith('/test')) return { ok: true, dimensions: 1536 };
        if (options?.method === 'PUT')
          saved = { ...saved, ...JSON.parse(String(options.body)), generation: 'saved' };
        return { ...saved, conversations: conversationStatus };
      });
      await mount();
      expect(screen.getByRole('option', { name: connectionId })).toHaveProperty(
        'value',
        connectionId,
      );
      fireEvent.click(screen.getByLabelText(toggle));
      expect(screen.getByText('Save embedding settings')).toHaveProperty('disabled', true);
      fireEvent.change(screen.getByLabelText('Provider'), { target: { value: connectionId } });
      await screen.findByText(/No advertised capabilities/);
      fireEvent.change(screen.getByLabelText(manualLabel), {
        target: { value: '  embedding-deployment  ' },
      });
      expect(screen.getByText('Save embedding settings')).toHaveProperty('disabled', true);
      fireEvent.click(screen.getByText('Test embedding model'));
      await screen.findByText('Test successful · 1536 dimensions');
      fireEvent.click(screen.getByText('Save embedding settings'));
      await screen.findByText(/Conversations enabled/);
      expect(mocked).toHaveBeenCalledWith(
        root,
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({
            enabled: false,
            conversationEnabled: true,
            connectionId,
            model: 'embedding-deployment',
          }),
        }),
      );
      expect(screen.getByLabelText(toggle)).toHaveProperty('checked', true);
      expect(screen.getByLabelText('Enable Brains embeddings globally')).toHaveProperty(
        'checked',
        false,
      );
      expect(screen.getByText('Reindex memories and conversations')).toHaveProperty(
        'disabled',
        false,
      );
      fireEvent.click(screen.getByText('Reindex memories and conversations'));
      await waitFor(() =>
        expect(mocked).toHaveBeenCalledWith(
          `${root}/reindex`,
          expect.objectContaining({ method: 'POST' }),
        ),
      );
    },
  );
  it.each([
    [true, false],
    [false, true],
    [true, true],
  ])(
    'loads independent Brains=%s and conversations=%s with exact progress and scoped errors',
    async (enabled, conversationEnabled) => {
      mocked.mockResolvedValue({
        ...status,
        enabled,
        conversationEnabled,
        conversations: conversationStatus,
      });
      await mount();
      expect(screen.getByLabelText('Enable Brains embeddings globally')).toHaveProperty(
        'checked',
        enabled,
      );
      expect(screen.getByLabelText(toggle)).toHaveProperty('checked', conversationEnabled);
      expect(screen.getByText(/Conversations (enabled|disabled)/).textContent).toContain(
        'Indexed 96 / 120 · Pending 20 · Failed 4',
      );
      expect(screen.getByText(/Conversation indexing error/).textContent).toContain(
        'conversation_embedding_failed',
      );
      expect(screen.getByText(/Brains indexing error/).textContent).toContain(
        'brain_embedding_index_failed',
      );
      expect(
        screen.getByText(/Conversations (enabled|disabled)/).textContent?.includes('Catching up'),
      ).toBe(conversationEnabled);
    },
  );
  it('does not render a stray zero or catch-up label when numeric dirty count is zero', async () => {
    mocked.mockResolvedValue({
      ...status,
      conversationEnabled: true,
      conversations: { ...conversationStatus, backfillComplete: true, dirty: 0 },
    });
    await mount();
    expect(screen.getByText(/Conversations enabled/).textContent).toBe(
      'Conversations enabled · Indexed 96 / 120 · Pending 20 · Failed 4',
    );
  });
  it('disables both indexes without selection or test', async () => {
    mocked.mockResolvedValue({ ...status, enabled: true, conversationEnabled: true });
    await mount();
    fireEvent.click(screen.getByLabelText(toggle));
    fireEvent.click(screen.getByLabelText('Enable Brains embeddings globally'));
    expect(screen.getByText('Save embedding settings')).toHaveProperty('disabled', false);
    fireEvent.click(screen.getByText('Save embedding settings'));
    await waitFor(() =>
      expect(mocked).toHaveBeenCalledWith(
        root,
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({
            enabled: false,
            conversationEnabled: false,
            connectionId: null,
            model: null,
          }),
        }),
      ),
    );
  });
  it('keeps the conversation draft on save failure and allows retry', async () => {
    mocked.mockImplementation(async (path, options) => {
      if (options?.method === 'PUT') throw new Error('synthetic failure');
      return path.includes('/models')
        ? { ...discover('a'), models: [{ id: 'embed', name: 'Embedding model' }] }
        : status;
    });
    await mount();
    fireEvent.click(screen.getByLabelText(toggle));
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'a' } });
    await screen.findByRole('option', { name: 'Embedding model' });
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'embed' } });
    fireEvent.click(screen.getByText('Save embedding settings'));
    await screen.findByText(/Could not save embeddings/);
    expect(screen.getByLabelText(toggle)).toHaveProperty('checked', true);
    expect(screen.getByText('Save embedding settings')).toHaveProperty('disabled', false);
  });
  it('marks conversation-only edits dirty, blocks guard-save without selection, and discards them', async () => {
    const navigated = vi.fn();
    function Destination() {
      const navigate = useUnsavedNavigation();
      return <button onClick={() => navigate(navigated)}>Leave settings</button>;
    }
    render(
      <UnsavedChangesProvider>
        <BrainEmbeddingSettings savedProviders={providers} />
        <Destination />
      </UnsavedChangesProvider>,
    );
    await waitFor(() => expect(screen.getByLabelText(toggle)).toHaveProperty('disabled', false));
    fireEvent.click(screen.getByLabelText(toggle));
    fireEvent.click(screen.getByText('Leave settings'));
    await screen.findByRole('alertdialog');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(navigated).not.toHaveBeenCalled();
    expect(
      screen.getByText(/Choose a connection and embedding model or deployment ID;/),
    ).toBeTruthy();
    expect(mocked.mock.calls.some(([, options]) => options?.method === 'PUT')).toBe(false);
    fireEvent.click(screen.getByText('Leave settings'));
    await screen.findByRole('alertdialog');
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(navigated).toHaveBeenCalledOnce());
    expect(screen.getByLabelText(toggle)).toHaveProperty('checked', false);
  });
  it('fences a deferred poll against a conversation-only reindex epoch', async () => {
    const old = deferred<object>();
    let reads = 0;
    let epoch = '1';
    mocked.mockImplementation(async (path, options) => {
      if (path === '/api/settings/brain-memory') return { promoteDreamsToMemory: true };
      if (options?.method === 'POST') epoch = '2';
      else if (++reads === 2) return old.promise;
      return {
        ...status,
        conversationEnabled: true,
        conversations: { ...conversationStatus, epoch, indexed: epoch === '2' ? 120 : 96 },
      };
    });
    await mount();
    await waitFor(() => expect(reads).toBe(2));
    fireEvent.click(screen.getByText('Reindex memories and conversations'));
    await screen.findByText(/Conversations enabled · Indexed 120/);
    await act(async () =>
      old.resolve({ ...status, conversationEnabled: true, conversations: conversationStatus }),
    );
    expect(screen.getByText(/Conversations enabled/).textContent).toContain('Indexed 120');
  });
});
