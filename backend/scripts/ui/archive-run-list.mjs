import { archiveReadCheckpoint, archiveReadTasks } from '../../src/archive-read-scope.mjs';
import { archiveRunOccurrence, archiveRunBoundary, compareArchiveRunPosition, archiveCursorBoundary, archiveCursor } from '../../src/archive-pagination.mjs';
import { listArchiveRuns, listArchiveRunSummariesPage, listArchiveRunSummariesForScopes } from '../../src/archive-proof.mjs';

export async function archiveRunListPage({ scopes, agentId = null, sessionId = null, query = '', limit = 100, cursor = null, signal, deadline }) {
  const options = { signal, deadline };
  archiveReadCheckpoint(options);
  const size = Math.max(1, Math.min(200, Number(limit) || 100));
  const search = String(query ?? '').trim().toLowerCase();
  // Old cursors cannot locate an occurrence in a timestamp/run tie group.
  const scopeKey = JSON.stringify(['run-occurrences', agentId, sessionId, search]);
  const boundary = archiveCursorBoundary(cursor, { scope: scopeKey });
  const position = row => [String(row._sortTimestamp ?? row.completedAt ?? row.startedAt ?? ''), ...archiveRunOccurrence(row)];
  const boundaryPosition = boundary ? [boundary.t, ...archiveRunBoundary(boundary.i)] : null;
  // PostgreSQL text cannot contain NUL, so no stored summary can match it.
  if (search.includes('\0')) return { runs: [], hasMore: false, nextCursor: null };
  const globalPage = await listArchiveRunSummariesForScopes({ scopes, sessionId, query: search, limit: size, boundary, ...options });
  const pages = globalPage ? [globalPage] : await archiveReadTasks(scopes.map(scope => readOptions => listArchiveRunSummariesPage({ ...scope, sessionId, query: search, limit: size, boundary, ...readOptions })), options);
  let ordered, moreInStore = false;
  if (pages.every(page => page !== null)) {
    ordered = pages.flatMap(page => page.runs);
    moreInStore = pages.some(page => page.hasMore);
  } else {
    // Compatibility for injected non-PostgreSQL stores only.
    const lists = await archiveReadTasks(scopes.map(scope => readOptions => listArchiveRuns({ ...scope, sessionId, limit: null, summaryOnly: true, ...readOptions })), options);
    ordered = lists.flat().filter(run => (!search || `${run.agentName || run.agentId} ${run.objective || ''} ${run.finalAnswer || ''} ${run.status} ${run.runId}`.toLowerCase().includes(search))
      && (!boundaryPosition || compareArchiveRunPosition(position(run), boundaryPosition) > 0));
  }
  ordered.sort((left, right) => compareArchiveRunPosition(position(left), position(right)));
  const runs = ordered.slice(0, size);
  const hasMore = ordered.length > size || moreInStore;
  const last = runs.at(-1);
  const nextCursor = hasMore && last ? archiveCursor({ scope: scopeKey, timestamp: position(last)[0], identity: JSON.stringify(archiveRunOccurrence(last)) }) : null;
  return { runs: runs.map(({ _sortTimestamp, ...run }) => run), hasMore, nextCursor };
}
