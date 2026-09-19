import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { readArchiveConversationPage } from './session-store.mjs';
import { settingsKeyFromEnvironment } from './model-settings-store.mjs';
import { MOD_CAPABILITY_RESULT_MAX_BYTES, modCapabilityResultBytes } from './mod-capability-envelope.mjs';

// Domain-separated from encryption and archive cursors; the runtime settings key
// is persisted across Core restarts, unlike a module-local random UUID.
function signature(value) { return createHmac('sha256', settingsKeyFromEnvironment()).update('burrow-mod-conversation-cursor-v1\0').update(JSON.stringify(value)).digest('hex'); }
function badCursor() { throw new Error('mod_conversation_cursor_invalid'); }
function encode(value) { return Buffer.from(JSON.stringify({ ...value, mac: signature(value) })).toString('base64url'); }
function decode(value) {
  try {
    if (!/^[A-Za-z0-9_-]{1,8192}$/.test(value)) badCursor();
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    const { mac, ...payload } = parsed || {};
    if (typeof mac !== 'string' || !/^[a-f0-9]{64}$/.test(mac) || !timingSafeEqual(Buffer.from(mac), Buffer.from(signature(payload)))) badCursor();
    if (parsed?.v !== 1 || typeof parsed.before !== 'string' && parsed.before !== null || !Number.isSafeInteger(parsed.offset) || parsed.offset < 1 || typeof parsed.digest !== 'string' || !/^[a-f0-9]{64}$/.test(parsed.digest)) badCursor();
    return parsed;
  } catch { badCursor(); }
}
function digest(turn) { return createHash('sha256').update(JSON.stringify(turn)).digest('hex'); }
function warnings(status, turns, gaps) {
  return [...(status === 'unavailable' ? ['archive_history_unavailable'] : []),
    ...(turns.some((turn) => turn.contentTruncated) ? ['stored_turn_content_truncated'] : []),
    ...(gaps.length ? ['turn_metadata_exceeds_envelope'] : [])];
}
function output(target, turns, gaps, hasMore, nextCursor, status) {
  const historyStatus = gaps.length ? 'unavailable' : status;
  return { ...target, turns, gaps, hasMore, nextCursor, historyStatus, historyWarnings: warnings(historyStatus, turns, gaps) };
}
// Segment content at Unicode scalar boundaries. Offsets are code-point indexes,
// allowing exact reassembly without splitting UTF-16 surrogate pairs.
function segmentTurn(turn, offset, target, status, before, next, scope) {
  const chars = Array.from(turn.content);
  if (offset >= chars.length) badCursor();
  const hash = digest(turn);
  let low = 1, high = chars.length - offset, best = 0;
  const make = (length) => {
    const end = offset + length;
    const piece = { ...turn, content: chars.slice(offset, end).join(''), segment: { turnId: turn.id, index: offset, start: offset, end, total: chars.length, digest: hash } };
    const more = end < chars.length || Boolean(next);
    const cursor = end < chars.length ? encode({ v: 1, before, offset: end, digest: hash, scope }) : next;
    return output(target, [piece], [], more, cursor, status);
  };
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (modCapabilityResultBytes(make(mid)) <= MOD_CAPABILITY_RESULT_MAX_BYTES) { best = mid; low = mid + 1; }
    else high = mid - 1;
  }
  return best ? make(best) : null;
}

export async function readModConversationPage({ rootDir, sessionId, archiveId, limit, before, from, to, agentId }) {
  const target = { agentId, sessionId, archiveId };
  const scope = createHash('sha256').update(JSON.stringify({ rootDir, target, from, to })).digest('hex');
  let segment = null;
  if (before) {
    let raw;
    try { raw = JSON.parse(Buffer.from(before, 'base64url').toString('utf8')); } catch {}
    if (raw?.v === 1) segment = decode(before);
  }
  if (segment && segment.scope !== scope) badCursor();
  let cursor = segment ? segment.before : before;
  let status = null;
  const turns = [];
  const gaps = [];
  for (let i = 0; i < limit; i++) {
    const page = await readArchiveConversationPage({ rootDir, sessionId, archiveId, limit: 1, before: cursor, from, to });
    if (!page) { if (i === 0) return null; throw new Error('archive_conversation_not_found'); }
    status = page.historyStatus === 'unavailable' || status === 'unavailable' ? 'unavailable' : 'complete';
    const turn = page.turns[0];
    if (!turn) return output(target, turns, gaps, false, null, status);
    if (segment) {
      if (digest(turn) !== segment.digest || typeof turn.content !== 'string') badCursor();
      const piece = segmentTurn(turn, segment.offset, target, status, cursor, page.nextCursor, scope);
      if (!piece) badCursor(); // A previously issued segment must remain resumable.
      return piece;
    }
    const candidate = output(target, [...turns, turn], gaps, page.hasMore, page.nextCursor, status);
    if (modCapabilityResultBytes(candidate) > MOD_CAPABILITY_RESULT_MAX_BYTES) {
      if (turns.length || gaps.length) return output(target, turns, gaps, true, cursor, status);
      if (typeof turn.content === 'string' && turn.content.length) {
        const piece = segmentTurn(turn, 0, target, status, cursor, page.nextCursor, scope);
        if (piece) return piece;
      }
      // Even one content scalar cannot fit with the turn's metadata. Report
      // the omitted turn explicitly and advance instead of retrying forever.
      const gap = { turnId: turn.id, reason: 'turn_metadata_exceeds_envelope' };
      const omitted = output(target, turns, [gap], page.hasMore, page.nextCursor, status);
      if (modCapabilityResultBytes(omitted) > MOD_CAPABILITY_RESULT_MAX_BYTES) throw new Error('mod_capability_output_limit');
      return omitted;
    }
    turns.push(turn);
    if (!page.hasMore) return candidate;
    cursor = page.nextCursor;
  }
  return output(target, turns, gaps, true, cursor, status);
}
