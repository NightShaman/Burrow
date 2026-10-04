import { afterEach, describe, expect, it, vi } from 'vitest';
import { clientBudgets, isWithinAttachmentBudget } from './clientBudgets';

describe('client budgets', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });
  it('keeps attachment admission within file, count, and aggregate bounds', () => {
    expect(isWithinAttachmentBudget([8 * 1024 * 1024], 8 * 1024 * 1024)).toBe(true);
    expect(isWithinAttachmentBudget([8 * 1024 * 1024, 8 * 1024 * 1024], 1)).toBe(false);
    expect(isWithinAttachmentBudget(Array(8).fill(1), 1)).toBe(false);
  });
  it('accepts only positive safe-integer deployment overrides', async () => {
    vi.stubGlobal('window', { __BURROW_CLIENT_BUDGETS__: { requestDeadlineMs: 1234, attachmentCount: 0, unexpected: 4 } });
    const module = await import('./clientBudgets');
    expect(module.clientBudgets.requestDeadlineMs).toBe(1234);
    expect(module.clientBudgets.attachmentCount).toBe(clientBudgets.attachmentCount);
    expect(Object.isFrozen(module.clientBudgets)).toBe(true);
  });
});
