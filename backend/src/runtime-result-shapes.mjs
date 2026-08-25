import path from 'node:path';

// Runtime ownership rule:
// Tool implementations own raw results and any full artifact. Everything that
// crosses into loop state, a receipt, a session, or a child handoff is a
// CompactReceipt. This is a runaway-memory boundary, not presentation polish.
const RECEIPT_TEXT_LIMITS = Object.freeze({
  content: 16_000,
  stdout: 8_000,
  stderr: 2_000,
  summary: 4_000,
  preview: 4_000,
  error: 1_000,
  command: 1_000,
  evidence: 8,
  list: 20,
});

function compactText(value, maxChars) {
  const text = typeof value === 'string' ? value : String(value || '');
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n[${text.length - maxChars} chars omitted]` : text;
}

function compactList(values, limit = RECEIPT_TEXT_LIMITS.list) {
  return Array.isArray(values) ? values.slice(0, limit).map((value) => compactText(value, 500)) : undefined;
}

function coverageFromToolResult(toolResult = {}) {
  if (toolResult.tool !== 'files_read') return undefined;
  const returnedBytes = toolResult.returnedBytes ?? (typeof toolResult.content === 'string' ? Buffer.byteLength(toolResult.content, toolResult.encoding || 'utf8') : undefined);
  const totalBytes = toolResult.bytes ?? returnedBytes;
  return {
    truncated: Boolean(toolResult.truncated),
    bytes: totalBytes ?? null,
    returnedBytes: returnedBytes ?? null,
    range: returnedBytes == null ? null : { start: Number(toolResult.offsetBytes || 0), end: Number(toolResult.offsetBytes || 0) + returnedBytes },
    nextRange: toolResult.truncated && returnedBytes != null && totalBytes != null
      ? { start: Number(toolResult.offsetBytes || 0) + returnedBytes, end: totalBytes }
      : null,
  };
}

function compactToolRecord(record) {
  if (!record || typeof record !== 'object') return undefined;
  return {
    id: record.id || null,
    status: record.status || null,
    phase: record.phase || null,
    owner: record.owner ? { sessionId: record.owner.sessionId || null, conversationId: record.owner.conversationId || null } : undefined,
    trace: record.trace ? { runId: record.trace.runId || null, childSessionId: record.trace.childSessionId || null } : undefined,
  };
}

function deliveryFromToolResult(toolResult = {}) {
  if (toolResult.tool !== 'files_read' || typeof toolResult.content !== 'string') return undefined;
  const rawContent = toolResult.content;
  const deliveredPrefix = rawContent.slice(0, RECEIPT_TEXT_LIMITS.content);
  const deliveredBytes = Buffer.byteLength(deliveredPrefix, toolResult.encoding || 'utf8');
  const rawReturnedBytes = toolResult.returnedBytes ?? Buffer.byteLength(rawContent, toolResult.encoding || 'utf8');
  const offsetBytes = Number(toolResult.offsetBytes || 0);
  const sourceDelivery = toolResult.delivery || {};
  return {
    returnedBytes: sourceDelivery.returnedBytes ?? deliveredBytes,
    truncated: sourceDelivery.truncated ?? (deliveredBytes < rawReturnedBytes || Boolean(toolResult.truncated)),
    nextOffsetBytes: sourceDelivery.nextOffsetBytes ?? (offsetBytes + deliveredBytes),
  };
}

export function summarizeToolResults(toolResults = []) {
  return (toolResults || []).map((toolResult, index) => ({
    activityId: toolResult.activityId || `tool-${index + 1}`,
    tool: toolResult.tool || null,
    ok: toolResult.ok ?? null,
    ...(toolResult.tool === 'mcp_call' ? {
      mcpToolName: toolResult.mcpToolName ? compactText(toolResult.mcpToolName, 240) : null,
      provider: toolResult.provider ? compactText(toolResult.provider, 120) : null,
      // Connection IDs and raw MCP output remain in trace-owned results; compact
      // receipts retain only the safe provider/tool identity and status.
      connectionId: undefined,
    } : {}),
    command: toolResult.command ? compactText(toolResult.command, RECEIPT_TEXT_LIMITS.command) : null,
    reason: toolResult.reason ? compactText(toolResult.reason, 500) : null,
    filePath: toolResult.filePath || null,
    path: toolResult.path || undefined,
    dirPath: toolResult.dirPath || undefined,
    pattern: toolResult.pattern || undefined,
    contentHash: toolResult.contentHash || undefined,
    resultFingerprint: toolResult.resultFingerprint || undefined,
    exists: typeof toolResult.exists === 'boolean' ? toolResult.exists : undefined,
    type: toolResult.type || undefined,
    size: Number.isFinite(Number(toolResult.size)) ? Number(toolResult.size) : undefined,
    modifiedAt: toolResult.modifiedAt || undefined,
    workspaceRoot: toolResult.workspaceRoot || undefined,
    cwd: toolResult.cwd || undefined,
    target: toolResult.target?.root ? { kind: toolResult.target.kind || null, root: toolResult.target.root } : undefined,
    touchedFiles: compactList(toolResult.touchedFiles),
    changedFiles: compactList(toolResult.changedFiles),
    offsetBytes: Number.isFinite(Number(toolResult.offsetBytes)) ? Number(toolResult.offsetBytes) : undefined,
    nextOffsetBytes: Number.isFinite(Number(toolResult.nextOffsetBytes)) ? Number(toolResult.nextOffsetBytes) : undefined,
    returnedBytes: Number.isFinite(Number(toolResult.returnedBytes)) ? Number(toolResult.returnedBytes) : undefined,
    bytes: Number.isFinite(Number(toolResult.bytes)) ? Number(toolResult.bytes) : undefined,
    exitCode: toolResult.exitCode ?? undefined,
    error: toolResult.error ? compactText(toolResult.error, RECEIPT_TEXT_LIMITS.error) : null,
    failureClass: toolResult.failureClass || null,
    profile: toolResult.profile || undefined,
    requestedProfile: toolResult.requestedProfile || undefined,
    id: toolResult.id || undefined,
    childSessionId: toolResult.childSessionId || undefined,
    spawnRequestKey: toolResult.spawnRequestKey || undefined,
    reused: toolResult.reused === true || undefined,
    status: toolResult.status || undefined,
    spawned: toolResult.spawned === true || undefined,
    sideEffectsApplied: toolResult.sideEffectsApplied === true || undefined,
    senderAgentId: toolResult.senderAgentId || undefined,
    recipientAgentId: toolResult.recipientAgentId || undefined,
    sourceSessionId: toolResult.sourceSessionId || undefined,
    targetSessionId: toolResult.targetSessionId || undefined,
    sourceEntryId: toolResult.sourceEntryId || undefined,
    recipientEntryId: toolResult.recipientEntryId || undefined,
    deliveredAt: toolResult.deliveredAt || undefined,
    messageMode: toolResult.messageMode || undefined,
    reply: toolResult.reply && typeof toolResult.reply === 'object'
      ? {
          ok: toolResult.reply.ok ?? null,
          runId: toolResult.reply.runId || null,
          entryId: toolResult.reply.entryId || null,
          recipientReplyEntryId: toolResult.reply.recipientReplyEntryId || null,
          content: toolResult.reply.content ? compactText(toolResult.reply.content, RECEIPT_TEXT_LIMITS.content) : null,
          error: toolResult.reply.error ? compactText(toolResult.reply.error, RECEIPT_TEXT_LIMITS.error) : null,
        }
      : undefined,
    blockers: compactList(toolResult.blockers),
    warnings: compactList(toolResult.warnings),
    // Bounded excerpts are evidence, not ownership of a raw tool result. Full
    // output remains with the producing tool's artifact/result file.
    content: typeof toolResult.content === 'string' ? compactText(toolResult.content, RECEIPT_TEXT_LIMITS.content) : undefined,
    query: typeof toolResult.query === 'string' ? compactText(toolResult.query, 1_000) : undefined,
    project: typeof toolResult.project === 'string' ? compactText(toolResult.project, 500) : undefined,
    requestedProject: typeof toolResult.requestedProject === 'string' ? compactText(toolResult.requestedProject, 500) : undefined,
    entersPrompt: toolResult.entersPrompt === false ? false : undefined,
    resultCount: Number.isFinite(Number(toolResult.resultCount)) ? Number(toolResult.resultCount) : undefined,
    provider: typeof toolResult.provider === 'string' ? compactText(toolResult.provider, 120) : undefined,
    connectionId: toolResult.tool === 'mcp_call' ? undefined : (typeof toolResult.connectionId === 'string' ? compactText(toolResult.connectionId, 120) : undefined),
    mcpToolName: typeof toolResult.mcpToolName === 'string' ? compactText(toolResult.mcpToolName, 240) : undefined,
    nextCursor: typeof toolResult.nextCursor === 'string' ? compactText(toolResult.nextCursor, 120) : undefined,
    totalCount: Number.isFinite(Number(toolResult.totalCount)) ? Number(toolResult.totalCount) : undefined,
    providers: Array.isArray(toolResult.providers)
      ? toolResult.providers.slice(0, RECEIPT_TEXT_LIMITS.list).map((provider) => ({ id: provider?.id || null, name: typeof provider?.name === 'string' ? compactText(provider.name, 120) : null, transport: provider?.transport || null, catalogToolCount: Number(provider?.catalogToolCount) || 0, grantedToolCount: Number(provider?.grantedToolCount) || 0, available: provider?.available === true }))
      : undefined,
    mcpCapabilities: Array.isArray(toolResult.tools)
      ? toolResult.tools.slice(0, 20).map((tool) => ({ name: typeof tool?.name === 'string' ? compactText(tool.name, 240) : null, description: typeof tool?.description === 'string' ? compactText(tool.description, 2_000) : null, inputSchema: tool?.inputSchema && typeof tool.inputSchema === 'object' && !Array.isArray(tool.inputSchema) ? tool.inputSchema : { type: 'object', properties: {} }, granted: tool?.granted === true }))
      : undefined,
    entries: Array.isArray(toolResult.entries) ? toolResult.entries.slice(0, RECEIPT_TEXT_LIMITS.list).map((item) => ({ path: item?.path || null, type: item?.type || null })) : undefined,
    paths: compactList(toolResult.paths),
    matches: Array.isArray(toolResult.matches) ? toolResult.matches.slice(0, RECEIPT_TEXT_LIMITS.list).map((item) => ({ filePath: item?.filePath || null, line: item?.line ?? null, text: compactText(item?.text, 500) })) : undefined,
    results: Array.isArray(toolResult.results)
      ? toolResult.results.slice(0, RECEIPT_TEXT_LIMITS.evidence).map((item) => ({
        kind: item?.kind || null,
        id: item?.id || null,
        project: item?.project || null,
        title: typeof item?.title === 'string' ? compactText(item.title, 500) : null,
        content: typeof item?.content === 'string' ? compactText(item.content, RECEIPT_TEXT_LIMITS.preview) : null,
        summary: typeof item?.summary === 'string' ? compactText(item.summary, RECEIPT_TEXT_LIMITS.preview) : undefined,
        sourceRef: item?.sourceRef || null,
        sourceRefs: compactList(item?.sourceRefs),
        recentRefs: compactList(item?.recentRefs),
        firstSeen: item?.firstSeen || undefined,
        lastSeen: item?.lastSeen || undefined,
        recurrence: Number.isFinite(Number(item?.recurrence)) ? Number(item.recurrence) : undefined,
        evidence: typeof item?.evidence === 'string' ? compactText(item.evidence, 120) : undefined,
        score: Number.isFinite(Number(item?.score)) ? Number(item.score) : null,
      }))
      : undefined,
    tasks: Array.isArray(toolResult.tasks)
      ? toolResult.tasks.slice(0, RECEIPT_TEXT_LIMITS.evidence).map((task) => ({
        id: task?.id || null, projectId: task?.projectId || null,
        title: typeof task?.title === 'string' ? compactText(task.title, 500) : null,
        description: typeof task?.description === 'string' ? compactText(task.description, RECEIPT_TEXT_LIMITS.preview) : null,
        status: task?.status || null, priority: task?.priority || null,
        assignedAgentId: task?.assignedAgentId || null, updatedAt: task?.updatedAt || null,
      }))
      : undefined,
    task: toolResult.task && typeof toolResult.task === 'object'
      ? { id: toolResult.task.id || null, projectId: toolResult.task.projectId || null, title: typeof toolResult.task.title === 'string' ? compactText(toolResult.task.title, 500) : null, status: toolResult.task.status || null, priority: toolResult.task.priority || null, assignedAgentId: toolResult.task.assignedAgentId || null, updatedAt: toolResult.task.updatedAt || null }
      : undefined,
    stdout: typeof toolResult.stdout === 'string' ? compactText(toolResult.stdout, RECEIPT_TEXT_LIMITS.stdout) : undefined,
    stdoutOriginalChars: Number.isFinite(Number(toolResult.stdoutOriginalChars)) ? Number(toolResult.stdoutOriginalChars) : undefined,
    stderr: typeof toolResult.stderr === 'string' ? compactText(toolResult.stderr, RECEIPT_TEXT_LIMITS.stderr) : undefined,
    summary: typeof toolResult.summary === 'string' ? compactText(toolResult.summary, RECEIPT_TEXT_LIMITS.summary) : undefined,
    preview: typeof toolResult.preview === 'string' ? compactText(toolResult.preview, RECEIPT_TEXT_LIMITS.preview) : undefined,
    profiles: Array.isArray(toolResult.profiles)
      ? toolResult.profiles.slice(0, RECEIPT_TEXT_LIMITS.list).map((profile) => ({ name: profile?.name || null, description: compactText(profile?.description, 500), mutates: profile?.mutates === true || undefined, capabilities: compactList(profile?.capabilities) }))
      : undefined,
    items: Array.isArray(toolResult.items)
      ? toolResult.items.slice(0, RECEIPT_TEXT_LIMITS.list).map((item) => ({ id: item?.id || null, status: item?.status || null, purpose: compactText(item?.purpose, 500) }))
      : undefined,
    gate: toolResult.gate && typeof toolResult.gate === 'object'
      ? { ok: toolResult.gate.ok ?? null, blockers: compactList(toolResult.gate.blockers), workerProfile: toolResult.gate.workerProfile || null, mergePolicy: toolResult.gate.mergePolicy || null }
      : undefined,
    truncated: toolResult.truncated === true || undefined,
    stdoutTruncated: toolResult.stdoutTruncated === true || undefined,
    stderrTruncated: toolResult.stderrTruncated === true || undefined,
    verificationCheck: toolResult.verificationCheck === true || undefined,
    // Artifact paths are references to tool-owned raw output, not copies.
    artifacts: Array.isArray(toolResult.artifacts)
      ? toolResult.artifacts.slice(0, RECEIPT_TEXT_LIMITS.evidence).map((artifact) => ({ type: artifact?.type || null, path: typeof artifact?.path === 'string' ? compactText(artifact.path, RECEIPT_TEXT_LIMITS.command) : null }))
      : (toolResult.artifacts && typeof toolResult.artifacts === 'object'
        ? Object.fromEntries(Object.entries(toolResult.artifacts)
          .filter(([, value]) => typeof value === 'string')
          .slice(0, RECEIPT_TEXT_LIMITS.evidence))
        : undefined),
    record: compactToolRecord(toolResult.record),
    handoff: toolResult.handoff && typeof toolResult.handoff === 'object'
      ? { id: toolResult.handoff.id || null, agentId: toolResult.handoff.agentId || null, sessionId: toolResult.handoff.sessionId || null, runId: toolResult.handoff.runId || null, title: typeof toolResult.handoff.title === 'string' ? compactText(toolResult.handoff.title, 500) : null, sourceRefs: compactList(toolResult.handoff.sourceRefs), expiresAt: toolResult.handoff.expiresAt || null }
      : undefined,
    coverage: coverageFromToolResult(toolResult),
    delivery: deliveryFromToolResult(toolResult),
    // Child evidence is itself converted to receipts. Never retain an opaque
    // provider/child envelope or recursively copy its original evidence graph.
    evidence: Array.isArray(toolResult.evidence)
      ? summarizeToolResults(toolResult.evidence.slice(0, RECEIPT_TEXT_LIMITS.evidence))
      : undefined,
  }));
}

export const compactToolReceipts = summarizeToolResults;

export function compactSkippedActions(skipped = []) {
  return (skipped || []).map((item) => ({
    index: item.index ?? null,
    tool: item.tool || item.name || null,
    status: item.status || 'not_executed',
  }));
}

export function skippedActionsFromChatToolLoop(chatToolLoop = null) {
  return compactSkippedActions((chatToolLoop?.iterations || []).flatMap((iteration) => iteration.proposalExecution?.skipped || []));
}

function compactMutationRepairHistory(history = []) {
  return (history || []).map((item) => ({
    attempt: item.attempt ?? null,
    status: item.status || null,
    tool: item.tool || null,
    failureClass: item.failureClass || null,
    error: item.error || null,
  }));
}

export function compactExecution(execution) {
  if (!execution) return { executed: 0, skipped: [], tools: [] };
  return {
    executed: execution.executed ?? 0,
    skipped: compactSkippedActions(execution.skipped ?? []),
    defaultInspection: Boolean(execution.defaultInspection),
    mutationRepair: execution.mutationRepair ? {
      attempts: compactMutationRepairHistory(execution.mutationRepairHistory || []),
      providerFailed: Boolean(execution.mutationRepairProviderFailed),
      finalFailureClass: (execution.mutationRepairHistory || []).at(-1)?.failureClass || null,
    } : undefined,
    tools: summarizeToolResults(execution.toolResults || []),
  };
}

export function displayPathForToolResult(filePath, toolResult = {}) {
  if (!filePath) return null;
  const workspaceRoot = toolResult.workspaceRoot;
  if (workspaceRoot && path.isAbsolute(filePath)) {
    const relative = path.relative(workspaceRoot, filePath);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) return relative;
  }
  return filePath;
}

export function changedPathsFromToolResults(toolResults = []) {
  const changed = [];
  for (const toolResult of toolResults || []) {
    if (!toolResult?.ok || !['files_write', 'files_edit', 'files_patch'].includes(toolResult.tool)) continue;
    const paths = toolResult.tool === 'files_patch'
      ? (toolResult.touchedFiles || [])
      : [toolResult.filePath].filter(Boolean);
    for (const filePath of paths) {
      const displayPath = displayPathForToolResult(filePath, toolResult);
      if (displayPath && !changed.includes(displayPath)) changed.push(displayPath);
    }
  }
  return changed;
}

function discoveryOnlyFromToolResults(toolResults = []) {
  const successful = (toolResults || []).filter((result) => result?.ok);
  if (!successful.some((result) => result.tool === 'shell_exec')) return false;
  return !successful.some((result) => ['files_read', 'spawn_subagent', 'files_write', 'files_edit', 'files_patch'].includes(result.tool));
}

export function buildOutcome({ decision = null, sessionId = null, session = null, backgroundWork = null, workResult = null, proposal = null, memoryIntent = null, model = null, recentFiles = [], chatToolLoop = null } = {}) {
  const toolResults = workResult?.proposalExecution?.toolResults || chatToolLoop?.toolResults || [];
  const execution = workResult?.proposalExecution
    ? compactExecution(workResult.proposalExecution)
    : { executed: chatToolLoop?.toolResults?.length ?? 0, skipped: skippedActionsFromChatToolLoop(chatToolLoop), tools: summarizeToolResults(chatToolLoop?.toolResults || []) };
  const changedFiles = recentFiles.length ? recentFiles.map((file) => file.path) : changedPathsFromToolResults(toolResults);
  return {
    decision,
    sessionId: sessionId || null,
    sessionKind: session?.kind || null,
    workItemId: backgroundWork?.itemId || null,
    backgroundWork: backgroundWork ? {
      itemId: backgroundWork.itemId || null,
      status: backgroundWork.status || null,
      step: backgroundWork.step || null,
      blockers: backgroundWork.blockers || [],
      delegatedWork: backgroundWork.delegatedWork || null,
    } : null,
    execution: {
      proposedActions: workResult?.proposedActions?.length ?? proposal?.actions?.length ?? 0,
      executedActions: execution.executed || 0,
      skippedActions: execution.skipped || [],
      changedFiles: [...new Set(changedFiles.filter(Boolean))],
      discoveryOnly: discoveryOnlyFromToolResults(toolResults),
      mutationRepair: execution.mutationRepair,
    },
    verification: workResult?.verification || null,
    commit: workResult?.commit || null,
    memory: memoryIntent ? {
      recall: memoryIntent.recall,
      handoff: memoryIntent.handoff,
      writeback: memoryIntent.writeback,
    } : null,
    model: model ? { ok: model.ok ?? null, usage: model.usage || null } : null,
  };
}
