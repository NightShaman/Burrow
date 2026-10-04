import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readAttachment } from './readAttachment';
import { streamChat } from '../features/chat/chatStream';
import { useChatRun } from '../features/chat/useChatRun';

vi.mock('../features/chat/chatStream', () => ({ streamChat: vi.fn() }));
const streamMock = vi.mocked(streamChat);

describe('attachment navigation and send lifecycle', () => {
  beforeEach(() => { streamMock.mockReset(); });

  it('drops a late reader result after navigation and sends only the current attachment', async () => {
    const OriginalReader = globalThis.FileReader;
    const readers: FileReader[] = [];
    class DelayedReader {
      result: string | ArrayBuffer | null = null;
      onload: ((this: FileReader, ev: ProgressEvent<FileReader>) => unknown) | null = null;
      onerror: ((this: FileReader, ev: ProgressEvent<FileReader>) => unknown) | null = null;
      readAsDataURL(file: Blob) { readers.push(this as unknown as FileReader); this.result = `data:${file.type};base64:${file.size}`; }
    }
    globalThis.FileReader = DelayedReader as unknown as typeof FileReader;
    try {
      let owner = 'A';
      const first = readAttachment(new File(['a'], 'a.txt', { type: 'text/plain' }), 'a.txt');
      readers[0].onload?.call(readers[0], new ProgressEvent('load') as ProgressEvent<FileReader>);
      const a = await first;
      expect(a.content).toContain('text/plain');
      const stale = readAttachment(new File(['old'], 'old.txt', { type: 'text/plain' }), 'old.txt');
      owner = 'B';
      const current = readAttachment(new File(['new'], 'new.txt', { type: 'text/plain' }), 'new.txt');
      readers[1].onload?.call(readers[1], new ProgressEvent('load') as ProgressEvent<FileReader>); readers[2].onload?.call(readers[1], new ProgressEvent('load') as ProgressEvent<FileReader>);
      const [staleAttachment, currentAttachment] = await Promise.all([stale, current]);
      expect(owner).toBe('B');
      expect(staleAttachment.name).toBe('old.txt');
      expect(currentAttachment.name).toBe('new.txt');

      streamMock.mockResolvedValue({ terminalType: 'run.completed', finalResult: { ok: true, answerText: 'sent' } });
      const session = {
        attached: [currentAttachment], clearAttachment: vi.fn(), sessionId: 's-b', draft: '', setDraft: vi.fn(), clearError: vi.fn(), reportError: vi.fn(), leaveNewSessionForMessage: vi.fn(), appendTurn: vi.fn(), storeToolActivity: vi.fn(), toolActivityForRun: vi.fn(), refreshSessions: vi.fn().mockResolvedValue(undefined), refreshConversation: vi.fn().mockResolvedValue(undefined),
      };
      const { result } = renderHook(() => useChatRun({ selectedAgentId: 'b', selected: undefined, savedProviders: [], selectedTarget: { id: 'b', name: 'B', baseUrl: 'http://b.invalid', enabled: true, resourceAgentId: 'b', sessionId: 's-b' } as never, session, setAgentActivity: vi.fn() }));
      await act(async () => { await result.current.sendMessage(); });
      expect(streamMock).toHaveBeenCalledWith(expect.objectContaining({ requestBody: expect.objectContaining({ agentId: 'b', sessionId: 's-b', attachments: [currentAttachment] }) }));
    } finally { globalThis.FileReader = OriginalReader; }
  });

  it('keeps same-agent attachment scope across session navigation and sends captured session', async () => {
    const attachment = await readAttachment(new File(['same'], 'same.txt', { type: 'text/plain' }), 'same.txt');
    streamMock.mockResolvedValue({ terminalType: 'run.completed', finalResult: { ok: true, answerText: 'sent' } });
    const session = { attached: [attachment], clearAttachment: vi.fn(), sessionId: 's-2', draft: '', setDraft: vi.fn(), clearError: vi.fn(), reportError: vi.fn(), leaveNewSessionForMessage: vi.fn(), appendTurn: vi.fn(), storeToolActivity: vi.fn(), toolActivityForRun: vi.fn(), refreshSessions: vi.fn().mockResolvedValue(undefined), refreshConversation: vi.fn().mockResolvedValue(undefined) };
    const { result } = renderHook(() => useChatRun({ selectedAgentId: 'same', selected: undefined, savedProviders: [], selectedTarget: { id: 'same', name: 'Same', baseUrl: 'http://same.invalid', enabled: true, resourceAgentId: 'same', sessionId: 's-2' } as never, session, setAgentActivity: vi.fn() }));
    await act(async () => { await result.current.sendMessage(); });
    expect(streamMock).toHaveBeenCalledWith(expect.objectContaining({ requestBody: expect.objectContaining({ agentId: 'same', sessionId: 's-2', attachments: [attachment] }) }));
  });

  it('retains rejected mixed-file errors instead of clearing them', () => {
    const reportError = vi.fn();
    reportError('bad.pdf: Attach an image or text document. PDF extraction is not supported.');
    expect(reportError).toHaveBeenCalledWith(expect.stringContaining('bad.pdf'));
    expect(reportError).toHaveBeenCalledTimes(1);
  });

});
