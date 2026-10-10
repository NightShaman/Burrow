import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrainEmbeddingSettings } from './BrainEmbeddingSettings';
import { api } from '../../app/api';
import type { SavedProvider } from '../../app/types';
vi.mock('../../app/api', () => ({ api: vi.fn() }));
const mocked = vi.mocked(api);
const status = { enabled: false, connectionId: null, model: null, generation: '9007199254740993', total: '9007199254740995', indexed: '2', pending: '3', failed: '1', storage: 'postgres_float8_exact_cosine', lastError: 'brain_embedding_index_failed' };
const providers = ['a', 'b'].map(id => ({ id, provider: id, apiType: 'ollama', url: '', apiKey: '', models: ['chat-only'] })) as SavedProvider[];
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const discover = (connectionId: string) => ({ connectionId, provider: 'ollama', models: [] as { id: string; name: string }[], capabilityDisclosure: 'No advertised capabilities' });
beforeEach(() => { mocked.mockReset(); mocked.mockImplementation(async path => path.includes('/models') ? discover(new URL(path, 'http://test').searchParams.get('connectionId')!) : status); });
afterEach(cleanup);
async function mount() { render(<BrainEmbeddingSettings savedProviders={providers} />); await waitFor(() => expect((screen.getByLabelText('Provider') as HTMLSelectElement).disabled).toBe(false)); }
describe('Brain embedding settings', () => {
  it('keeps disabled defaults and exact string counts; disabling never needs consent', async () => {
    await mount(); expect((screen.getByLabelText('Enable Brains embeddings globally') as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText(/Indexed 2 \/ 9007199254740995/).textContent).toContain('Generation 9007199254740993');
    fireEvent.click(screen.getByText('Save embedding settings'));
    await waitFor(() => expect(mocked).toHaveBeenCalledWith('/api/settings/brain-embeddings', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ enabled: false, connectionId: null, model: null }) })));
  });
  it('uses embedding discovery, manual fallback without acknowledgment gates', async () => {
    await mount(); fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'a' } });
    await screen.findByText(/No advertised capabilities/);
    expect(screen.queryByText('chat-only')).toBeNull();
    fireEvent.change(screen.getByLabelText('Embedding model ID (manual fallback)'), { target: { value: 'embed-manual' } });
    fireEvent.click(screen.getByLabelText('Enable Brains embeddings globally'));
    const test = screen.getByText('Test embedding model') as HTMLButtonElement;
    expect(test.disabled).toBe(false);
    expect(screen.queryByLabelText(/I confirm provider requests/)).toBeNull();
    expect(screen.queryByText(/Memories are explicit agent-owned records/)).toBeNull();
    expect((screen.getByText('Save embedding settings') as HTMLButtonElement).disabled).toBe(true);
    mocked.mockImplementation(async path => path.endsWith('/test') ? { ok: true, dimensions: 768 } : status);
    fireEvent.click(test); await screen.findByText('Test successful · 768 dimensions');
    expect(mocked).toHaveBeenCalledWith('/api/settings/brain-embeddings/test', expect.objectContaining({ body: JSON.stringify({ connectionId: 'a', model: 'embed-manual' }) }));
    expect((screen.getByText('Save embedding settings') as HTMLButtonElement).disabled).toBe(false);
  });
  it('discards deferred discovery for a previous connection', async () => {
    const old = deferred<ReturnType<typeof discover>>();
    mocked.mockImplementation(async path => path.includes('connectionId=a') ? old.promise : path.includes('/models') ? discover('b') : status);
    await mount(); fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'a' } });
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'b' } });
    await screen.findByText(/No advertised capabilities/);
    await act(async () => old.resolve({ ...discover('a'), models: [{ id: 'stale', name: 'STALE MODEL' }] }));
    expect(screen.queryByText('STALE MODEL')).toBeNull();
  });
  it('discards an old owner load after remount', async () => {
    const old = deferred<typeof status>(); mocked.mockReturnValueOnce(old.promise);
    const view = render(<BrainEmbeddingSettings savedProviders={providers} />); view.unmount();
    await mount(); await act(async () => old.resolve({ ...status, enabled: true }));
    expect((screen.getByLabelText('Enable Brains embeddings globally') as HTMLInputElement).checked).toBe(false);
  });
  it('fences a deferred poll against save and the returned generation', async () => {
    const old = deferred<typeof status>(); let reads = 0;
    mocked.mockImplementation(async (_path, options) => options?.method === 'PUT' ? { ...status, generation: 'new', indexed: '7' } : ++reads === 2 ? old.promise : { ...status, generation: reads > 2 ? 'new' : status.generation, indexed: reads > 2 ? '7' : '2' });
    await mount(); await waitFor(() => expect(reads).toBe(2));
    fireEvent.click(screen.getByText('Save embedding settings')); await screen.findByText(/Generation new/);
    await act(async () => old.resolve(status));
    expect(screen.getByText(/Generation new/).textContent).toContain('Indexed 7');
  });
  it('does not publish an old test after owner unmount', async () => {
    const old = deferred<{ ok: true; dimensions: number }>();
    mocked.mockImplementation(async path => path.endsWith('/test') ? old.promise : path.includes('/models') ? discover('a') : status);
    const view = render(<BrainEmbeddingSettings savedProviders={providers} />);
    await waitFor(() => expect((screen.getByLabelText('Provider') as HTMLSelectElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'a' } });
    fireEvent.change(screen.getByLabelText('Embedding model ID (manual fallback)'), { target: { value: 'manual' } });
    fireEvent.click(screen.getByText('Test embedding model'));
    view.unmount(); await mount(); await act(async () => old.resolve({ ok: true, dimensions: 999 }));
    expect(screen.queryByText(/999 dimensions/)).toBeNull();
  });
});
