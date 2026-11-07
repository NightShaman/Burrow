import { beforeEach, describe, expect, it } from 'vitest';
import { setupOperation } from './setupOperation';

const form = {
  operatorName: ' Operator ',
  operatorAvatar: 'a',
  name: ' Agent One ',
  avatar: 'b',
  soul: 'original',
  connectionId: 'c',
  model: 'm',
};
beforeEach(() => localStorage.clear());
describe('setupOperation retained submission', () => {
  it('reuses the exact serialized payload and operation ID when the form changes', () => {
    const first = setupOperation(form);
    const retry = setupOperation({ ...form, name: 'Different', soul: 'changed', model: 'other' });
    expect(first.operationId).toBeTruthy();
    expect(retry.operationId).toBe(first.operationId);
    expect(JSON.stringify(retry)).toBe(JSON.stringify(first));
    expect(localStorage.getItem('hc.setupOperation')).toBe(JSON.stringify(first));
  });
  it('repairs only the legacy five-document payload while retaining its ID and content', () => {
    const first = setupOperation(form);
    const legacy = { ...first, documents: first.documents.filter((d) => d.kind !== 'PREFERENCES') };
    localStorage.setItem('hc.setupOperation', JSON.stringify(legacy));
    const repaired = setupOperation({ ...form, soul: 'changed' });
    expect(repaired.operationId).toBe(first.operationId);
    expect(repaired.documents).toEqual(first.documents);
    expect(localStorage.getItem('hc.setupOperation')).toBe(JSON.stringify(repaired));
    expect(JSON.stringify(setupOperation({ ...form, name: 'other' }))).toBe(
      JSON.stringify(repaired),
    );
  });
});
