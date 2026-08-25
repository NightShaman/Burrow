import { randomUUID } from 'node:crypto';

export function createFallbackRunId() {
  return `ask-${Date.now()}-${randomUUID().slice(0, 8)}`;
}

export function normalizedAttachments(args = {}) {
  return Array.isArray(args.attachments) ? args.attachments.filter((attachment) => attachment && typeof attachment === 'object') : [];
}

export function attachmentSummary(attachments = []) {
  return attachments.map((attachment, index) => ({
    index,
    name: String(attachment.name || `attachment-${index + 1}`),
    type: String(attachment.type || attachment.mimeType || 'application/octet-stream'),
    size: attachment.size ?? null,
    encoding: String(attachment.encoding || 'utf8'),
    ...(attachment.artifactPath ? { artifactPath: attachment.artifactPath } : {}),
    ...(attachment.storedAt ? { storedAt: attachment.storedAt } : {}),
  }));
}

export function isImageAttachment(attachment = {}) {
  const type = String(attachment.type || attachment.mimeType || '').toLowerCase();
  const content = String(attachment.content || '').toLowerCase();
  return type.startsWith('image/') || content.startsWith('data:image/');
}

export function decodeTextAttachmentContent(attachment = {}) {
  const content = String(attachment.content || '');
  if (!content.startsWith('data:')) return content;
  const comma = content.indexOf(',');
  if (comma === -1) return content;
  const meta = content.slice(5, comma).toLowerCase();
  const payload = content.slice(comma + 1);
  try {
    if (meta.includes(';base64')) return Buffer.from(payload, 'base64').toString('utf8');
    return decodeURIComponent(payload);
  } catch {
    return '[Attachment content could not be decoded as text]';
  }
}

export function promptTextAttachments(attachments = []) {
  return attachments.filter((attachment) => !isImageAttachment(attachment)).map((attachment, index) => ({
    name: String(attachment.name || `attachment-${index + 1}`),
    type: String(attachment.type || attachment.mimeType || 'application/octet-stream'),
    size: attachment.size ?? null,
    encoding: String(attachment.encoding || 'utf8'),
    content: decodeTextAttachmentContent(attachment),
  }));
}

export function extraEyesRequested(args = {}) {
  return Boolean(args.extra_eyes || args.extraEyes || args.parent_directed_review || args.parentDirectedReview);
}

export function pendingActionForTurnPlan(turnPlan = null) {
  return turnPlan?.intentFacts?.pendingAction || null;
}

export function userTurnMetadata({ command, session, intent, attachments, turnPlan, subjectScope = null } = {}) {
  const pendingAction = pendingActionForTurnPlan(turnPlan);
  return {
    command,
    session,
    intent,
    attachments: attachmentSummary(attachments),
    ...(pendingAction ? { pendingAction } : {}),
    ...(subjectScope ? { subjectScope } : {}),
  };
}

export function normalizeRuntimeTurnInput({ args = {}, workspaceRoot = null, target = null, action = null, noCallModel = false, callModel = false, agentRuntime = null } = {}) {
  if (agentRuntime) {
    const authorityKeys = ['agent_id', 'agent_workspace_root', 'agent_data_root', 'skills_root', 'filesystem_boundaries', 'data_root'];
    for (const key of authorityKeys) {
      if (args[key] !== undefined) {
        const error = new Error(`agent_runtime_override_forbidden:${key}`);
        error.statusCode = 400;
        throw error;
      }
    }
  }
  const { run_preflights: _retiredRunPreflights, ...inputArgs } = args;
  const normalizedArgs = {
    ...inputArgs,
    workspace_root: workspaceRoot ?? inputArgs.workspace_root,
    target: target ?? args.target ?? null,
    action: action ?? args.action,
    no_call_model: noCallModel || args.no_call_model,
    call_model: callModel || args.call_model,
    ...(agentRuntime ? { agent_id: agentRuntime.agentId } : {}),
  };
  return {
    normalizedArgs,
    attachments: normalizedAttachments(normalizedArgs),
  };
}
