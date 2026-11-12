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
    await waitFor(() =>
      expect(reportError).toHaveBeenCalledWith(expect.stringContaining('bad.pdf')),
    );
    await waitFor(() => expect(readAttachment).toHaveBeenCalled());
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

it('admits backend-supported JSONL/JS and normalized generic UTF8 but reports binary rejection', async () => {
  const realReader = await vi.importActual<typeof import('./readAttachment')>('./readAttachment');
  vi.mocked(readAttachment).mockImplementation(realReader.readAttachment);
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
      isAttachmentScopeCurrent: () => true,
      setAttachment,
    }),
  );
  act(() =>
    result.current.attachImage([
      new File(['{"ok":true}\n'], 'data.jsonl', { type: 'application/x-ndjson' }),
      new File(['export default true;'], 'module.mjs', { type: 'application/javascript' }),
      new File(['name="José"'], 'config.toml'),
      new File(['{\\rtf1 José}\r\n'], 'rich.rtf', { type: 'application/rtf' }),
      new File([new Uint8Array([0, 1, 2])], 'binary.txt', { type: 'application/octet-stream' }),
    ]),
  );
  await waitFor(() =>
    expect(setAttachment).toHaveBeenCalledWith([
      expect.objectContaining({
        name: 'data.jsonl',
        type: 'application/x-ndjson',
        content: 'data:application/x-ndjson;base64,eyJvayI6dHJ1ZX0K',
      }),
      expect.objectContaining({ name: 'module.mjs', type: 'application/javascript' }),
      expect.objectContaining({
        name: 'config.toml',
        type: 'text/plain',
        size: 12,
        encoding: 'data-url',
        content: 'data:application/octet-stream;base64,bmFtZT0iSm9zw6ki',
      }),
      expect.objectContaining({
        name: 'rich.rtf',
        type: 'text/plain',
        encoding: 'data-url',
        content: 'data:application/rtf;base64,e1xydGYxIEpvc8OpfQ0K',
      }),
    ]),
  );
  expect(reportError).toHaveBeenCalledWith(expect.stringContaining('binary control'));
});
