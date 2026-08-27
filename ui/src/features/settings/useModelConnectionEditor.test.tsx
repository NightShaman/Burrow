import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../app/api';
import type { SavedProvider } from '../../app/types';
import { modelConnectionsApi } from './modelConnectionsApi';
import { useModelConnectionEditor } from './useModelConnectionEditor';

const confirmMock = vi.fn();

vi.mock('../../app/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../app/api')>()),
  api: vi.fn(),
}));
vi.mock('../../app/ConfirmDialog', () => ({ useConfirm: () => confirmMock }));

const apiMock = vi.mocked(api);

function renderEditor(onModelConnectionsChanged = vi.fn().mockResolvedValue(undefined)) {
  return { ...renderHook(() => useModelConnectionEditor({ onModelConnectionsChanged })), onModelConnectionsChanged };
}

const savedProvider: SavedProvider = {
  id: 'provider-1',
  provider: 'Example',
  apiType: 'openai-responses',
  url: 'https://example.test/v1',
  apiKey: '',
  apiKeyConfigured: true,
  models: ['vision', 'manual'],
  modelLabels: { vision: 'Vision' },
  modelDiscoveredInputs: { vision: ['text', 'image'] },
  modelInputOverrides: { vision: ['text'] },
  manualModels: { manual: true },
};

describe('useModelConnectionEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    confirmMock.mockResolvedValue(true);
  });

  it('hydrates saved providers and resets the editor without losing model metadata', () => {
    const { result } = renderEditor();
    act(() => result.current.editProvider(savedProvider));

    expect(result.current.editingId).toBe('provider-1');
    expect(result.current.provider).toBe('Example');
    expect(result.current.apiKeyConfigured).toBe(true);
    expect(result.current.availableModels).toEqual([
      expect.objectContaining({ id: 'vision', displayName: 'Vision', discoveredInput: ['text', 'image'], acceptedInputOverride: ['text'], acceptedInput: ['text'] }),
      expect.objectContaining({ id: 'manual', manual: true, acceptedInput: ['text'] }),
    ]);

    act(() => result.current.resetProvider());
    expect(result.current.editingId).toBeNull();
    expect(result.current.provider).toBe('');
    expect(result.current.availableModels).toEqual([]);
  });

  it('discovers models and saves the selected provider payload', async () => {
    vi.spyOn(modelConnectionsApi, 'discover').mockResolvedValue({ models: [{ id: 'model-a', selected: true, acceptedInput: ['text'] }] });
    apiMock.mockResolvedValue({});
    const { result, onModelConnectionsChanged } = renderEditor();
    act(() => {
      result.current.setProvider(' Example ');
      result.current.setUrl(' https://example.test/v1 ');
      result.current.setApiKey('secret');
    });

    await act(() => result.current.connect());
    expect(modelConnectionsApi.discover).toHaveBeenCalledWith(expect.objectContaining({ provider: 'Example', baseUrl: 'https://example.test/v1', apiKey: 'secret' }));
    expect(result.current.availableModels).toEqual([expect.objectContaining({ id: 'model-a' })]);

    await act(() => result.current.saveProvider());
    expect(apiMock).toHaveBeenCalledWith('/api/settings/model-connections', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ provider: 'Example', apiType: 'openai-chat-completions', baseUrl: 'https://example.test/v1', apiKey: 'secret', models: [{ id: 'model-a', selected: true, acceptedInput: ['text'] }] }),
    }));
    expect(onModelConnectionsChanged).toHaveBeenCalledOnce();
    expect(result.current.provider).toBe('');
    expect(result.current.savedProvidersOpen).toBe(true);
  });

  it('keeps manual model IDs unique and updates capability overrides', () => {
    const { result } = renderEditor();
    act(() => result.current.setManualModel('manual-model'));
    act(() => result.current.addManualModel());
    expect(result.current.availableModels).toEqual([expect.objectContaining({ id: 'manual-model', manual: true })]);

    act(() => result.current.setManualModel('manual-model'));
    act(() => {
      result.current.addManualModel();
      result.current.toggleModelInput('manual-model', 'image');
    });
    expect(result.current.availableModels).toHaveLength(1);
    expect(result.current.availableModels[0]).toEqual(expect.objectContaining({ acceptedInputOverride: ['text', 'image'] }));

    act(() => result.current.setModelInputAuto('manual-model', true));
    expect(result.current.availableModels[0].acceptedInputOverride).toBeUndefined();
  });

  it('confirms deletion and refreshes saved connections', async () => {
    apiMock.mockResolvedValue({});
    const { result, onModelConnectionsChanged } = renderEditor();
    await act(() => result.current.deleteProvider(savedProvider));

    expect(confirmMock).toHaveBeenCalledWith(expect.objectContaining({ title: 'Delete provider?', tone: 'danger' }));
    expect(apiMock).toHaveBeenCalledWith('/api/settings/model-connections/provider-1', { method: 'DELETE' });
    expect(onModelConnectionsChanged).toHaveBeenCalledOnce();
  });
});
