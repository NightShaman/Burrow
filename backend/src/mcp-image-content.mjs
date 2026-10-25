import { MODEL_VISIBLE_IMAGE_TYPES, persistChatAttachments, readAttachmentArtifact } from './attachment-store.mjs';

const EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

// Only MCP's typed content array is a binary contract. Never hunt through
// arbitrary JSON keys or decode strings/text blocks that happen to look base64.
// Known mcporter success wrappers are normalized by protectMcpOutput first.
export async function persistMcpImages(output, options = {}) {
  if (!output || typeof output !== 'object' || !Array.isArray(output.content)) return { output, attachments: [] };
  const attachments = [];
  const content = [];
  for (const block of output.content) {
    if (block?.type !== 'image') { content.push(block); continue; }
    const type = typeof block.mimeType === 'string' ? block.mimeType.toLowerCase() : '';
    const data = block.data;
    // Buffer's base64 decoder is intentionally forgiving; validate the MCP
    // field before handing it to the existing attachment store instead.
    const valid = typeof data === 'string' && data.length > 0 && data.length <= Math.ceil(MAX_IMAGE_BYTES / 3) * 4
      && data.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(data) && Buffer.from(data, 'base64').length <= MAX_IMAGE_BYTES && Buffer.from(data, 'base64').toString('base64') === data;
    if (!MODEL_VISIBLE_IMAGE_TYPES.has(type) || !valid) {
      content.push({ type: 'image', mimeType: type, error: !MODEL_VISIBLE_IMAGE_TYPES.has(type) ? 'image_type_not_model_visible' : 'mcp_image_data_invalid_or_too_large' });
      continue;
    }
    const [stored] = await persistChatAttachments({ ...options, attachments: [{ name: `mcp-image-${attachments.length + 1}.${EXTENSIONS[type]}`, type, content: `data:${type};base64,${data}` }] });
    const attachment = await readAttachmentArtifact({ agentWorkspaceRoot: options.agentWorkspaceRoot, artifactPath: stored.artifactPath, attachment: stored });
    if (!attachment) throw new Error('mcp_image_attachment_unavailable');
    attachments.push(attachment);
    content.push({ type: 'image', mimeType: type, attachmentId: attachment.id, artifactPath: attachment.artifactPath, name: attachment.name, size: attachment.size });
  }
  return { output: { ...output, content }, attachments };
}
