import { archivePage } from '../../src/archive-pagination.mjs';
import { listArchiveRuns } from '../../src/archive-proof.mjs';

// All rows are needed for cross-agent cursor ordering, but only summaries are
// needed. Never hydrate detail here, including when limit is null.
export async function archiveRunListPage({ scopes, agentId = null, sessionId = null, limit = 100, cursor = null }) {
  const lists = await Promise.all(scopes.map(scope => listArchiveRuns({ ...scope, sessionId, limit: null, summaryOnly: true })));
  const page = archivePage(lists.flat(), { limit, cursor, max: 200, scope: JSON.stringify(['runs', agentId, sessionId]), timestamp: row => row.completedAt || row.startedAt, identity: row => `${row.agentId}:${row.runId}` });
  return { runs: page.items, nextCursor: page.nextCursor, hasMore: page.hasMore };
}
