import { afterEach, expect, it } from 'vitest';
import { retainedOperation, completeOperation } from './durableOperation';
afterEach(() => localStorage.clear());
it('retains exact setup payload through uncertain response/reload and edited form', () => {
 const submitted = { operationId: 'stable', operator: { name: 'Original', avatar: '' }, documents: [{ kind: 'SOUL', markdown: 'Original' }] };
 expect(retainedOperation('setup', () => submitted)).toEqual(submitted);
 expect(retainedOperation('setup', () => ({ ...submitted, operationId: 'changed' }))).toEqual(submitted);
 completeOperation('setup', 'unrelated');
 expect(localStorage.getItem('setup')).not.toBeNull();
 completeOperation('setup', 'stable');
 expect(localStorage.getItem('setup')).toBeNull();
});
