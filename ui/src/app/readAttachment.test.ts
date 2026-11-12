import { describe, expect, it } from 'vitest';
import { readAttachment } from './readAttachment';
import { validatedAttachmentType } from '../features/chat/attachmentValidation';

describe('actual attachment FileReader', () => {
  it.each([
    ['text/plain', 'hello', 'aGVsbG8='],
    ['image/png', 'image', 'aW1hZ2U='],
  ])('reads %s bytes without changing metadata', async (type, content, encoded) => {
    const file = new File([content], 'fixture', { type });
    expect(await readAttachment(file, 'owned-fixture')).toEqual({
      name: 'owned-fixture',
      type,
      size: file.size,
      encoding: 'data-url',
      content: `data:${type};base64,${encoded}`,
    });
  });
});

it.each(['application/octet-stream', 'application/rtf', ''])(
  'normalizes only admitted MIME metadata, preserving exact original bytes (%s)',
  async (originalType) => {
    const content = '\uFEFF{\\rtf1 José 山田}\r\n\t  keep spacing\n';
    const originalBytes = new TextEncoder().encode(content);
    const file = new File([originalBytes], 'original-config.rtf', {
      type: originalType,
      lastModified: 1234,
    });
    const type = await validatedAttachmentType(file);
    const original = await readAttachment(file, file.name);
    const normalized = { ...original, type };
    expect(normalized).toEqual({
      name: file.name,
      type: 'text/plain',
      size: originalBytes.length,
      encoding: 'data-url',
      content: original.content,
    });
    expect(original.content.split(',', 1)[0]).toBe(
      `data:${originalType || 'application/octet-stream'};base64`,
    );
    const binary = atob(normalized.content.slice(normalized.content.indexOf(',') + 1));
    expect(Array.from(binary, (character) => character.charCodeAt(0))).toEqual([...originalBytes]);
    expect(file.type).toBe(originalType);
    expect(file.lastModified).toBe(1234);
  },
);
