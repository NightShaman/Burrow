import { archivePage, archiveCursorBoundary, archiveCursor } from '../../src/archive-pagination.mjs';
import { listArchiveRuns, listArchiveRunSummariesPage } from '../../src/archive-proof.mjs';

export async function archiveRunListPage({ scopes, agentId = null, sessionId = null, limit = 100, cursor = null }) {
  const size = Math.max(1, Math.min(200, Number(limit) || 100));
  const scopeKey = JSON.stringify(['runs', agentId, sessionId]);
  const boundary = archiveCursorBoundary(cursor, { scope: scopeKey });
  const pages = await Promise.all(scopes.map(scope => listArchiveRunSummariesPage({ ...scope, sessionId, limit: size, boundary })));
  if (pages.every(page => page !== null)) {
    const ordered = pages.flatMap(page => page.runs).sort((left, right) => {
      const lt = String(left._sortTimestamp || left.completedAt || left.startedAt || ''), rt = String(right._sortTimestamp || right.completedAt || right.startedAt || '');
      const li = `${left.agentId}:${left.runId}`, ri = `${right.agentId}:${right.runId}`;
      return lt < rt ? 1 : lt > rt ? -1 : li < ri ? 1 : li > ri ? -1 : 0;
    });
    const runs = ordered.slice(0, size);
    const hasMore = ordered.length > size || pages.some(page => page.hasMore);
    const last = runs.at(-1);
    const nextCursor = hasMore && last ? archiveCursor({ scope: scopeKey, timestamp: String(last._sortTimestamp || last.completedAt || last.startedAt || ''), identity: `${last.agentId}:${last.runId}` }) : null;
    return { runs: runs.map(({ _sortTimestamp, ...run }) => run), hasMore, nextCursor };
  }
  // Compatibility for injected non-PostgreSQL stores. Production PostgreSQL
  // stores never fall back to reconstructing all conversations.
  const lists = await Promise.all(scopes.map(scope => listArchiveRuns({ ...scope, sessionId, limit: null, summaryOnly: true })));
  const page = archivePage(lists.flat(), { limit: size, cursor, max: 200, scope: scopeKey, timestamp: row => row.completedAt || row.startedAt, identity: row => `${row.agentId}:${row.runId}` });
  return { runs: page.items, nextCursor: page.nextCursor, hasMore: page.hasMore };
}
