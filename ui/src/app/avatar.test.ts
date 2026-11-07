import { afterEach, expect, it, vi } from 'vitest';
import { optimizeAvatar } from './avatar';
import { optimizeAvatar as compatibilityAvatar } from '../features/settings/OperatorProfile';

afterEach(() => vi.restoreAllMocks());
it('retains the component compatibility export', () => {
  expect(compatibilityAvatar).toBe(optimizeAvatar);
});
it('rejects invalid types and oversized input before allocating image resources', async () => {
  await expect(
    optimizeAvatar(new File(['text'], 'avatar.txt', { type: 'text/plain' })),
  ).rejects.toThrow('Choose or paste an image file for the avatar.');
  const file = new File([], 'avatar.png', { type: 'image/png' });
  Object.defineProperty(file, 'size', { value: 50_000_001 });
  await expect(optimizeAvatar(file)).rejects.toThrow('Maximum original file size is 50 MB.');
});
it('preserves aspect ratio, webp quality order and URL cleanup', async () => {
  const revoke = vi.fn();
  vi.stubGlobal('URL', { createObjectURL: () => 'blob:avatar', revokeObjectURL: revoke });
  vi.stubGlobal(
    'Image',
    class {
      naturalWidth = 1024;
      naturalHeight = 256;
      onload?: () => void;
      set src(_: string) {
        queueMicrotask(() => this.onload?.());
      }
    },
  );
  const drawImage = vi.fn();
  const toDataURL = vi
    .fn()
    .mockReturnValueOnce('x'.repeat(512_001))
    .mockReturnValueOnce('data:image/webp;base64,ok');
  const canvas = { width: 0, height: 0, getContext: () => ({ drawImage }), toDataURL };
  const original = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string) =>
    tag === 'canvas' ? canvas : original(tag)) as typeof document.createElement);
  try {
    await expect(optimizeAvatar(new File([], 'avatar.png', { type: 'image/png' }))).resolves.toBe(
      'data:image/webp;base64,ok',
    );
    expect(canvas.width).toBe(512);
    expect(canvas.height).toBe(128);
    expect(toDataURL.mock.calls).toEqual([
      ['image/webp', 0.86],
      ['image/webp', 0.72],
    ]);
    expect(revoke).toHaveBeenCalledWith('blob:avatar');
  } finally {
    vi.unstubAllGlobals();
  }
});
