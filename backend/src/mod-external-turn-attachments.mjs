import { isDeepStrictEqual } from 'node:util';
import { chatTurnInputFromBody } from './chat-turn-controller.mjs';

// Use the ordinary chat controller as the sole normalizer (including its image
// budget and text handling). Unlike interactive chat's forgiving input, durable
// acceptance must not silently drop an attachment or truncate its bytes.
export function normalizeExternalTurnAttachments(value) {
  if (value === undefined) return [];
  const invalid = () => { throw new Error('mod_capability_input_invalid'); };
  if (!Array.isArray(value)) invalid();
  for (const attachment of value) {
    if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment)) invalid();
    if (Object.keys(attachment).some(key => !['name', 'type', 'mimeType', 'size', 'encoding', 'content'].includes(key))) invalid();
    for (const key of ['name', 'type', 'mimeType', 'encoding']) {
      if (attachment[key] !== undefined && typeof attachment[key] !== 'string') invalid();
    }
    if (attachment.size !== undefined && attachment.size !== null && (!Number.isSafeInteger(attachment.size) || attachment.size < 0)) invalid();
    if (typeof attachment.content !== 'string' || !attachment.content) invalid();
  }
  const normalized = chatTurnInputFromBody({ body: { message: 'attachment validation', attachments: value } }).args.attachments || [];
  if (normalized.length !== value.length) invalid();
  for (let i = 0; i < normalized.length; i++) {
    const attachment = normalized[i];
    if (attachment.content !== value[i].content || /^https?:\/\//i.test(attachment.content)) invalid();
    // The native vision path only takes data:image/... URLs. Do not accept an
    // external (possibly credential-bearing) URL or malformed bytes as an image.
    if (attachment.type.toLowerCase().startsWith('image/') || attachment.content.toLowerCase().startsWith('data:image/')) {
      const match = /^data:(image\/[^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(attachment.content);
      if (!match || match[1].toLowerCase() !== attachment.type.toLowerCase() || match[2].length % 4 !== 0) invalid();
      const bytes = Buffer.from(match[2], 'base64');
      if (!bytes.length || bytes.toString('base64') !== match[2]) invalid();
    }
  }
  return normalized;
}

export function sameExternalTurnInput(left, right) {
  return left.agentId === right.agentId && left.sessionId === right.sessionId && left.message === right.message
    && (left.displayMessage || left.message) === (right.displayMessage || right.message)
    && isDeepStrictEqual(left.attachments || [], right.attachments || []);
}
