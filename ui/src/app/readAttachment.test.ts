import { describe, expect, it } from 'vitest';
import { readAttachment } from './readAttachment';

describe('actual attachment FileReader', () => {
  it.each([['text/plain', 'hello', 'aGVsbG8='], ['image/png', 'image', 'aW1hZ2U=']])('reads %s bytes without changing metadata', async (type, content, encoded) => {
    const file = new File([content], 'fixture', { type });
    expect(await readAttachment(file, 'owned-fixture')).toEqual({ name: 'owned-fixture', type, size: file.size, encoding: 'data-url', content: `data:${type};base64,${encoded}` });
  });
});
