import { isDisplayChatMessage } from '../../src/session-entry.mjs';
import { compactChatTurn } from '../../src/compact-chat-turn.mjs';

// The archive pager reconstructs only this reset generation, deduplicates
// retained tail entries, and hydrates only one bounded page. It is a display
// projection: prompt/context readers continue to use the active transcript.
export async function activeSessionDetail({ store, agentId, sessionId, cursorSecret, limit = 200, before = null, summarizeSessionTurns }) {
  const { page, activity, liveChat } = await store.readActiveSessionDisplay({ agentId, sessionId, cursorSecret, limit, before });
  // An archive ID is not an active session, even if it happens to be supplied.
  if (!page || page.archiveSnapshot) return null;
  const extra = liveChat.filter(e => e.metadata?.chatInput && e.role && !isDisplayChatMessage(e));
  // Preserve the pager's canonical transcript order even for equal or skewed clocks.
  const merged = page.entries.map((entry, index) => entry.id ? entry
    : { ...entry, id: page.displayIds?.[index] });
  for (const entry of [...extra, ...activity]) {
    const at = merged.findIndex(other => String(other.ts || '') > String(entry.ts || ''));
    merged.splice(at < 0 ? merged.length : at, 0, entry);
  }
  const turns = merged.map(compactChatTurn);
  return { id: sessionId, turnCount: page.turnCount, metadata: page.metadata,
    summary: page.metadata.summary || summarizeSessionTurns(page.entries, { maxChars: 2000 }), turns,
    activities: activity.filter(turn => turn.metadata?.toolActivity).map(turn => ({ ...turn.metadata.toolActivity, runId: turn.runId || null })),
    hasMore: page.hasMore, nextCursor: page.nextCursor, historyStatus: page.historyStatus };
}
