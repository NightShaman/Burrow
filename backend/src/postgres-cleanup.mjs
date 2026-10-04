/** Retry the existing owned handle; never replace ownership or unlink its data.
 * Each stop attempt has the lifecycle command timeout. The budget bounds retry
 * scheduling, not an arbitrary application lifetime.
 */
export async function closePostgresWithRetry(handle, { budgetMs = 60_000, retryDelayMs = 100, onRetry = () => {} } = {}) {
  if (!Number.isFinite(budgetMs) || budgetMs <= 0 || !Number.isFinite(retryDelayMs) || retryDelayMs <= 0) throw new Error('Invalid PostgreSQL cleanup budget');
  const deadline = performance.now() + budgetMs;
  for (;;) {
    try { await handle.close(); return; }
    catch (error) {
      if (performance.now() + retryDelayMs >= deadline) throw new AggregateError([error], 'PostgreSQL cleanup budget exhausted; owned cluster retained for operator recovery');
      onRetry(error);
      await new Promise(resolve => setTimeout(resolve, retryDelayMs));
    }
  }
}
