import { describe, expect, it } from 'vitest';
import { isWithinAttachmentBudget } from './attachmentValidation';

describe('attachment batch validation', () => {
 it('enforces documented per-file, aggregate and count budgets before reading', () => {
  expect(isWithinAttachmentBudget([], 8 * 1024 * 1024)).toBe(true);
  expect(isWithinAttachmentBudget([], 8 * 1024 * 1024 + 1)).toBe(false);
  expect(isWithinAttachmentBudget([8 * 1024 * 1024, 8 * 1024 * 1024], 1)).toBe(false);
  expect(isWithinAttachmentBudget(Array(8).fill(0), 1)).toBe(false);
  expect(isWithinAttachmentBudget([], Number.NaN)).toBe(false);
 });
});
