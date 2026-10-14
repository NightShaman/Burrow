import { randomUUID } from 'node:crypto';

function compactRunIdPart(value = '') {
  return String(value || 'default').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'default';
}

export function createChatTurnRunId({ sessionId = 'default', prefix = 'ask' } = {}) {
  return `${compactRunIdPart(prefix)}-${compactRunIdPart(sessionId)}-${Date.now()}-${randomUUID().slice(0, 8)}`;
}
