import { describe, expect, it } from 'vitest';
import { validatedAttachmentType, isWithinAttachmentBudget } from './attachmentValidation';

describe('shared attachment text policy', () => {
  it.each([
    ['data.jsonl', 'application/x-ndjson', '{"a":1}\n', 'application/x-ndjson'],
    ['module.mjs', 'application/javascript', 'export const café = true;', 'application/javascript'],
    ['config.toml', '', '[project]\nname="山田"', 'text/plain'],
    ['run.sh', 'application/x-shellscript', '#!/bin/sh\necho hello', 'text/plain'],
    ['generic', 'application/octet-stream', 'plain UTF-8', 'text/plain'],
    ['rich.rtf', 'application/rtf', '{\\rtf1 hello}', 'text/plain'],
    ['notes', 'text/plain', '\tIndented\n\n', 'text/plain'],
  ])('validates %s from bytes rather than filename', async (name, type, bytes, expected) => {
    expect(await validatedAttachmentType(new File([bytes], name, { type }))).toBe(expected);
  });
  it.each(['', 'text/plain', 'application/octet-stream'])(
    'rejects disguised binary with MIME %s',
    async (type) => {
      await expect(
        validatedAttachmentType(new File([new Uint8Array([0, 1, 2])], 'not-text.txt', { type })),
      ).rejects.toThrow('binary control');
      await expect(
        validatedAttachmentType(new File([new Uint8Array([255, 254])], 'not-text.md', { type })),
      ).rejects.toThrow('UTF-8');
    },
  );
  it('reports specific PDF and unsupported-image reasons', async () => {
    await expect(
      validatedAttachmentType(new File(['pdf'], 'a.pdf', { type: 'application/pdf' })),
    ).rejects.toThrow('PDF text extraction');
    await expect(
      validatedAttachmentType(new File(['svg'], 'a.svg', { type: 'image/svg+xml' })),
    ).rejects.toThrow('PNG, JPEG, GIF, or WebP');
  });
});

describe('attachment batch validation', () => {
  it('enforces documented per-file, aggregate and count budgets before reading', () => {
    expect(isWithinAttachmentBudget([], 8 * 1024 * 1024)).toBe(true);
    expect(isWithinAttachmentBudget([], 8 * 1024 * 1024 + 1)).toBe(false);
    expect(isWithinAttachmentBudget([8 * 1024 * 1024, 8 * 1024 * 1024], 1)).toBe(false);
    expect(isWithinAttachmentBudget(Array(8).fill(0), 1)).toBe(false);
    expect(isWithinAttachmentBudget([], Number.NaN)).toBe(false);
  });
});
