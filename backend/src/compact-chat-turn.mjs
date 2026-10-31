import { compactDelegationMetadata } from './compact-delegation-metadata.mjs';

function compactAttachmentMetadata(attachment = {}, index = 0) {
  if (!attachment || typeof attachment !== 'object') return null;
  const projected = {
    index,
    name: String(attachment.name || `attachment-${index + 1}`),
    type: String(attachment.type || attachment.mimeType || 'application/octet-stream'),
    size: attachment.size ?? null,
    encoding: String(attachment.encoding || 'utf8'),
  };
  for (const key of ['artifactPath', 'storedAt']) {
    if (attachment[key] !== undefined && attachment[key] !== null) projected[key] = attachment[key];
  }
  return projected;
}


export function compactChatTurn(turn = {}) {
  const metadata = compactDelegationMetadata(turn.metadata);
  if (turn.metadata?.toolActivity) metadata.toolActivity = turn.metadata.toolActivity;
  if (Array.isArray(turn.metadata?.attachments)) {
    const attachments = turn.metadata.attachments.map(compactAttachmentMetadata).filter(Boolean);
    if (attachments.length) metadata.attachments = attachments;
  }
  for (const key of ['fromAgentName', 'fromAgentId', 'messageMode', 'direction', 'chatInput', 'lane', 'steering']) {
    if (turn.metadata?.[key] !== undefined) metadata[key] = turn.metadata[key];
  }
  return {
    id: turn.id,
    parentId: turn.parentId ?? null,
    ts: turn.ts,
    type: turn.type,
    role: turn.role,
    content: turn.content,
    contentTruncated: Boolean(turn.contentTruncated),
    runId: turn.runId ?? null,
    visibility: turn.visibility,
    ...(Object.keys(metadata).length ? { metadata } : {}),
  };
}
