import { redactText } from './redaction.mjs';

const DELEGATION_FIELDS = Object.freeze([
  'kind',
  'source',
  'parentAgentId',
  'parentSessionId',
  'parentConversationId',
  'parentRunId',
  'subagentId',
  'workerProfile',
]);
export const COMPACT_DELEGATION_MARKER_MAX_CHARS = 256;

// Preserve only source-authored, single-line attribution/identity markers. Do
// not infer delegation from a user role, session name or surrounding metadata.
// Omit invalid/oversized/sensitive markers rather than truncate or rewrite an
// identity into a different, apparently valid one. No payload objects escape.
export function compactDelegationMetadata(metadata) {
  const projected = {};
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return projected;
  for (const key of DELEGATION_FIELDS) {
    if (!Object.hasOwn(metadata, key)) continue;
    const value = metadata[key];
    if (value === null || (typeof value === 'string'
      && value.length <= COMPACT_DELEGATION_MARKER_MAX_CHARS
      && !/[\u0000-\u001f\u007f]/u.test(value)
      && redactText(value) === value)) projected[key] = value;
  }
  return projected;
}
