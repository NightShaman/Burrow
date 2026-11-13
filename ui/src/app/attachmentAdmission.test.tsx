import { useRef, useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type ChatAttachment } from './api';
import { readAttachment } from './readAttachment';
import { useAppMutations } from './useAppMutations';
import { useChatComposer } from '../features/chat/useChatComposer';
import { ChatComposer } from '../features/chat/ChatComposer';
import { GroupChannelsPage } from '../features/groups/GroupChannelsPage';

vi.mock('./api', async (original) => ({
  ...(await original<typeof import('./api')>()),
  api: vi.fn(),
}));
vi.mock('./readAttachment', async (original) => ({
  readAttachment: vi.fn((await original<typeof import('./readAttachment')>()).readAttachment),
}));
vi.mock('./clientBudgets', async (original) => {
  const actual = await original<typeof import('./clientBudgets')>();
  const clientBudgets = {
    ...actual.clientBudgets,
    attachmentFileBytes: 8,
    attachmentBatchBytes: 16,
  };
  return {
    clientBudgets,
    isWithinAttachmentBudget: (sizes: number[], bytes: number) =>
      bytes >= 0 &&
      bytes <= 8 &&
      sizes.length < 8 &&
      sizes.reduce((a, b) => a + b, 0) + bytes <= 16,
  };
});

function NormalComposer() {
  const scope = useRef({}).current;
  const composer = useChatComposer('admission', 'session', scope, () => true);
  const [error, reportError] = useState('');
  const { attachImage } = useAppMutations({
    selected: undefined,
    setAgents: () => {},
    refreshSessions: async () => {},
    writeModelSelection: async () => {},
    reportError,
    isAttachmentScopeCurrent: () => true,
    setAttachment: composer.setAttachment,
  });
  return (
    <>
      {error && <div role="alert">{error}</div>}
      <ChatComposer
        draft=""
        setDraft={() => {}}
        attached={composer.attached}
        onAttach={attachImage}
        onRemoveAttachment={composer.removeAttachment}
        onSend={() => {}}
        placeholder="Normal message"
      />
    </>
  );
}

const file = (name: string, size = 1, type = 'text/plain') =>
  new File(['x'.repeat(size)], name, { type });
const choose = (files: File[]) =>
  fireEvent.change(document.querySelector('input[type=file]')!, { target: { files } });
const names = () =>
  screen
    .queryAllByRole('button', { name: /^Remove / })
    .map((button) => button.getAttribute('aria-label')!.slice(7));
const attached = (name: string): ChatAttachment => ({
  name,
  size: 1,
  type: 'image/png',
  encoding: 'data-url',
  content: 'data:image/png;base64,eA==',
});
let realRead: typeof readAttachment;
beforeEach(async () => {
  realRead = (await vi.importActual<typeof import('./readAttachment')>('./readAttachment'))
    .readAttachment;
  vi.mocked(readAttachment).mockReset().mockImplementation(realRead);
  vi.mocked(api).mockImplementation(async () => ({
    channel: { id: 'room', name: 'Admission room', turns: [] },
  }));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

for (const surface of ['normal', 'group'] as const)
  describe(`${surface} attachment admission R6`, () => {
    async function mount() {
      render(
        surface === 'normal' ? (
          <NormalComposer />
        ) : (
          <GroupChannelsPage channelId="room" agents={[]} />
        ),
      );
      await screen.findByPlaceholderText(
        surface === 'normal' ? 'Normal message' : 'Message the group…',
      );
    }

    it('admits valid text after eight unsupported PDFs, preserving the real rejection reason', async () => {
      await mount();
      choose([
        ...Array.from({ length: 8 }, (_, i) => file(`bad-${i}.pdf`, 1, 'application/pdf')),
        file('valid.txt'),
      ]);
      await waitFor(() => expect(names()).toEqual(['valid.txt']));
      expect(screen.getByRole('alert').textContent).toContain(
        'bad-7.pdf: PDF text extraction is not supported.',
      );
      expect(readAttachment).toHaveBeenCalledTimes(1);
    });

    it('releases failed reads so later valid files are not crowded out', async () => {
      await mount();
      vi.mocked(readAttachment).mockRejectedValueOnce(new Error('Disk read failed'));
      choose(Array.from({ length: 9 }, (_, i) => file(`${i}.txt`)));
      await waitFor(() =>
        expect(names()).toEqual(Array.from({ length: 8 }, (_, i) => `${i + 1}.txt`)),
      );
      expect(screen.getByRole('alert').textContent).toContain('0.txt: Disk read failed');
    });

    it('preserves cross-batch selection order and rechecks the live count at commit', async () => {
      await mount();
      choose(Array.from({ length: 7 }, (_, i) => file(`${i}.txt`)));
      await waitFor(() => expect(names()).toHaveLength(7));
      let finish!: (item: ChatAttachment) => void;
      vi.mocked(readAttachment).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      choose([file('first.png', 1, 'image/png')]);
      choose([file('second.png', 1, 'image/png')]);
      await waitFor(() => expect(finish).toBeTypeOf('function'));
      expect(
        vi.mocked(readAttachment).mock.calls.some(([item]) => item.name === 'second.png'),
      ).toBe(false);
      await act(async () => finish(attached('first.png')));
      await waitFor(() =>
        expect(screen.getByRole('alert').textContent).toContain('second.png: Attachment exceeds'),
      );
      expect(names()).toEqual([...Array.from({ length: 7 }, (_, i) => `${i}.txt`), 'first.png']);
    });

    it('uses current attachments after removal while reading, not a stale selection snapshot', async () => {
      await mount();
      choose(Array.from({ length: 8 }, (_, i) => file(`${i}.txt`)));
      await waitFor(() => expect(names()).toHaveLength(8));
      let finish!: (item: ChatAttachment) => void;
      vi.mocked(readAttachment).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      choose([file('replacement.png', 1, 'image/png')]);
      await waitFor(() => expect(finish).toBeTypeOf('function'));
      fireEvent.click(screen.getByRole('button', { name: 'Remove 0.txt' }));
      await act(async () => finish(attached('replacement.png')));
      await waitFor(() => expect(names()).toContain('replacement.png'));
      expect(names()).toHaveLength(8);
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('enforces file/byte/count budgets and reports the rejected candidate', async () => {
      await mount();
      choose([file('oversized.txt', 9), file('a.txt', 8), file('b.txt', 8), file('excess.txt')]);
      await waitFor(() => expect(names()).toEqual(['a.txt', 'b.txt']));
      expect(screen.getByRole('alert').textContent).toContain('excess.txt: Attachment exceeds');
      expect(readAttachment).toHaveBeenCalledTimes(2);
      choose([file('late.txt')]);
      await waitFor(() =>
        expect(screen.getByRole('alert').textContent).toContain('late.txt: Attachment exceeds'),
      );
      expect(names()).toEqual(['a.txt', 'b.txt']);
    });

    it('reports file-size and binary rejection without blocking subsequent text', async () => {
      await mount();
      choose([file('oversized.txt', 9), file('valid.txt')]);
      await waitFor(() => expect(names()).toEqual(['valid.txt']));
      expect(screen.getByRole('alert').textContent).toContain(
        'oversized.txt: Attachment exceeds the client file safety budget.',
      );
      choose([new File([new Uint8Array([0])], 'binary.txt'), file('after.txt')]);
      await waitFor(() => expect(names()).toEqual(['valid.txt', 'after.txt']));
      expect(screen.getByRole('alert').textContent).toContain(
        'binary.txt: File contains binary control bytes',
      );
    });

    it('bounds actual FileReader parallelism across simultaneous mixed selections', async () => {
      await mount();
      let active = 0,
        peak = 0;
      for (const method of ['readAsArrayBuffer', 'readAsDataURL'] as const) {
        const original = FileReader.prototype[method];
        vi.spyOn(FileReader.prototype, method).mockImplementation(function (
          this: FileReader,
          blob: Blob,
        ) {
          active++;
          peak = Math.max(peak, active);
          this.addEventListener('loadend', () => active--, { once: true });
          original.call(this, blob);
        });
      }
      choose([file('a.txt'), file('bad.pdf', 1, 'application/pdf'), file('b.txt')]);
      choose([file('c.txt'), file('d.txt')]);
      await waitFor(() => expect(names()).toEqual(['a.txt', 'b.txt', 'c.txt', 'd.txt']));
      expect(peak).toBe(1);
      expect(active).toBe(0);
    });
  });
