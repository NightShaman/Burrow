import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useAppMutations } from './useAppMutations';
import type { Agent } from './types';

vi.mock('./api', () => ({ api: vi.fn(), attachmentDisplayName: (file: File) => file.name }));
vi.mock('./readAttachment', () => ({ readAttachment: vi.fn() }));
import { api } from './api';
import { readAttachment } from './readAttachment';

describe('App mutation owner', () => {
  it('rejects unsupported attachments and ignores a late read after scope changes', async () => {
    let current = true;
    let resolve!: (value: any) => void;
    vi.mocked(readAttachment).mockReturnValueOnce(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const reportError = vi.fn();
    const setAttachment = vi.fn();
    const { result } = renderHook(() =>
      useAppMutations({
        selected: undefined,
        setAgents: vi.fn(),
        refreshSessions: vi.fn(),
        reportError,
        writeModelSelection: vi.fn(),
        attached: [],
        isAttachmentScopeCurrent: () => current,
        setAttachment,
      }),
    );
    act(() =>
      result.current.attachImage([
        new File(['x'], 'bad.pdf', { type: 'application/pdf' }),
        new File(['hello'], 'ok.txt', { type: 'text/plain' }),
      ]),
    );
    expect(reportError).toHaveBeenCalledWith(expect.stringContaining('bad.pdf'));
    current = false;
    await act(async () => {
      resolve({ name: 'ok.txt' });
    });
    expect(setAttachment).not.toHaveBeenCalled();
  });
  it('patches routing then reports refresh failure without reporting mutation failure', async () => {
    vi.mocked(api).mockResolvedValueOnce({});
    const setAgents = vi.fn();
    const reportError = vi.fn();
    const refreshSessions = vi.fn().mockRejectedValue(new Error('offline'));
    const selected = {
      id: 'a',
      resourceId: 'a/b',
      contextConfig: { a2aInDefault: false },
    } as Agent;
    const { result } = renderHook(() =>
      useAppMutations({
        selected,
        setAgents,
        refreshSessions,
        reportError,
        writeModelSelection: vi.fn(),
        attached: [],
        isAttachmentScopeCurrent: () => true,
        setAttachment: vi.fn(),
      }),
    );
    await act(async () => {
      await result.current.updateAgent({ contextConfig: { a2aInDefault: true } });
    });
    expect(api).toHaveBeenCalledWith(
      '/api/agents/a%2Fb',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ contextConfig: { a2aInDefault: true } }),
      }),
    );
    expect(setAgents).toHaveBeenCalledOnce();
    await waitFor(() =>
      expect(reportError).toHaveBeenCalledWith(
        'A2A routing saved, but could not refresh sessions: offline',
      ),
    );
  });
});
