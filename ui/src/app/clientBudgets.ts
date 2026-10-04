/**
 * Browser-side defensive limits, not server policy. Values are defaults so an
 * operator can tune deployments via window.__BURROW_CLIENT_BUDGETS__ before the
 * UI bundle loads. Invalid/non-positive overrides are ignored.
 *
 * Attachment caps bound a single read and aggregate preview memory. Conversation
 * limits bound localStorage parse/stringify work and avoid one session monopolizing
 * storage. Archive caps bound restored list/detail payload work. The 30s request
 * deadline is a recovery bound for ordinary JSON/body parsing; chat streams are
 * exempt because their duration is user-driven.
 */
type BudgetName = 'attachmentFileBytes' | 'attachmentBatchBytes' | 'attachmentCount' | 'conversationCacheEntries' | 'conversationCacheTurnsPerEntry' | 'conversationCacheTextBytesPerTurn' | 'conversationCacheTotalTextBytes' | 'archiveSessionCacheEntries' | 'archiveDetailCacheEntries' | 'archiveSessionRowsPerQuery' | 'requestDeadlineMs';
type BudgetOverrides = Partial<Record<BudgetName, number>>;
declare global { interface Window { __BURROW_CLIENT_BUDGETS__?: unknown } }
const defaults: Record<BudgetName, number> = {
  attachmentFileBytes: 8 * 1024 * 1024, attachmentBatchBytes: 16 * 1024 * 1024, attachmentCount: 8,
  conversationCacheEntries: 24, conversationCacheTurnsPerEntry: 500, conversationCacheTextBytesPerTurn: 256 * 1024,
  conversationCacheTotalTextBytes: 8 * 1024 * 1024, archiveSessionCacheEntries: 12, archiveDetailCacheEntries: 24,
  archiveSessionRowsPerQuery: 500, requestDeadlineMs: 30_000,
};
function configuredBudgets(): BudgetOverrides {
  const candidate = typeof window === 'undefined' ? null : window.__BURROW_CLIENT_BUDGETS__;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return {};
  return Object.fromEntries(Object.entries(candidate as Record<string, unknown>).filter(([key, value]) => key in defaults && typeof value === 'number' && Number.isSafeInteger(value) && value > 0)) as BudgetOverrides;
}
export const clientBudgets: Readonly<Record<BudgetName, number>> = Object.freeze({ ...defaults, ...configuredBudgets() });
export function isWithinAttachmentBudget(fileSizes: number[], candidateBytes: number) {
  return Number.isFinite(candidateBytes) && candidateBytes >= 0 && candidateBytes <= clientBudgets.attachmentFileBytes
    && fileSizes.length < clientBudgets.attachmentCount
    && fileSizes.reduce((sum, value) => sum + value, 0) + candidateBytes <= clientBudgets.attachmentBatchBytes;
}
