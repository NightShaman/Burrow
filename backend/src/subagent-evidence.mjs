// Source coverage belongs to the producing tool; delivery coverage belongs to
// this projection. Reprojection must never turn a delivery omission into a
// claim that the source tool itself stopped early.
function prefix(value, limit) {
  let text = String(value ?? '').slice(0, limit);
  // Do not cut a UTF-16 surrogate pair: byte offsets must describe real UTF-8.
  if (text.length && /[\uD800-\uDBFF]/u.test(text.at(-1))) text = text.slice(0, -1);
  return text;
}

export function compactSubagentEvidence(result = {}, { textLimit = 6_000, stdoutLimit = textLimit, listLimit = 200, findLimit = listLimit } = {}) {
  const source = result.source || {
    truncated: Boolean(result.truncated), incomplete: Boolean(result.incomplete),
    entryBudgetExhausted: Boolean(result.entryBudgetExhausted), depthTruncated: Boolean(result.depthTruncated),
    stdoutTruncated: Boolean(result.stdoutTruncated), stderrTruncated: Boolean(result.stderrTruncated),
    ...(result.stdoutOriginalChars != null ? { stdoutOriginalChars: result.stdoutOriginalChars } : {}),
    ...(result.stderrOriginalChars != null ? { stderrOriginalChars: result.stderrOriginalChars } : {}),
  };
  const out = { tool: result.tool || 'unknown', ok: Boolean(result.ok), source,
    sideEffectsApplied: result.sideEffectsApplied,
    traceArtifact: result.traceArtifact || result.artifacts?.resultPath || null,
    artifacts: Array.isArray(result.artifacts)
      ? result.artifacts.map(item => ({ type: item?.type || null, path: typeof item?.path === 'string' ? item.path : null }))
      : result.artifacts && typeof result.artifacts === 'object'
        ? Object.fromEntries(Object.entries(result.artifacts).filter(([, value]) => typeof value === 'string')) : undefined,
    deliveryFields: {},
  };
  for (const key of ['toolCallId', 'filePath', 'path', 'dirPath', 'id', 'status', 'exists', 'type', 'size', 'modifiedAt', 'resultFingerprint', 'beforeHash', 'afterHash', 'offsetBytes', 'returnedBytes', 'bytes', 'encoding', 'exitCode', 'signal', 'timedOut', 'cancelled', 'verificationCheck', 'verificationExecution', 'evidenceCount', 'evidenceTraceDir', 'evidenceDelivery']) {
    if (result[key] !== undefined) out[key] = result[key];
  }
  const text = (key, limit) => {
    if (typeof result[key] !== 'string') return;
    out[key] = prefix(result[key], limit);
    const originalCount = result.deliveryFields?.[key]?.originalCount ?? result[key].length;
    out.deliveryFields[key] = { unit: 'chars', originalCount, deliveredCount: out[key].length, omittedCount: originalCount - out[key].length };
  };
  for (const [key, limit] of Object.entries({ content: textLimit, stdout: stdoutLimit, stderr: 1_200, command: 800, query: 1_000, pattern: 1_000, summary: textLimit, error: 800 })) text(key, limit);
  for (const key of ['entries', 'paths', 'matches', 'touchedFiles', 'changedFiles', 'blockers', 'warnings']) {
    if (!Array.isArray(result[key])) continue;
    const limit = key === 'paths' ? findLimit : ['entries', 'matches'].includes(key) ? listLimit : ['warnings', 'blockers'].includes(key) ? 8 : 20;
    out[key] = result[key].slice(0, limit).map((item) => {
      if (key === 'entries') return { path: item?.path || null, type: item?.type || null };
      if (key === 'matches') {
        const originalChars = item?.textDelivery?.originalCount ?? String(item?.text || '').length;
        const text = prefix(item?.text, 500);
        return { filePath: item?.filePath || null, line: item?.line ?? null, text,
          textDelivery: { unit: 'chars', originalCount: originalChars, deliveredCount: text.length, omittedCount: originalChars - text.length } };
      }
      return item;
    });
    const previous = result.deliveryFields?.[key] || result.deliveryCounts;
    const originalCount = previous?.originalCount ?? result[key].length;
    out.deliveryFields[key] = { unit: 'items', originalCount, deliveredCount: out[key].length, omittedCount: originalCount - out[key].length };
    if (['entries', 'paths', 'matches'].includes(key)) out.deliveryCounts = { originalCount, deliveredCount: out[key].length, omittedCount: originalCount - out[key].length, sourceTruncated: source.truncated };
  }
  out.deliveryTruncated = Boolean(result.deliveryTruncated) || Object.values(out.deliveryFields).some(field => field.omittedCount > 0)
    || (out.matches || []).some(item => item.textDelivery.omittedCount > 0);
  if (result.tool === 'files_read') {
    const returnedBytes = Buffer.byteLength(out.content || '', result.encoding || 'utf8');
    const originalBytes = Number(result.returnedBytes ?? returnedBytes);
    const offsetBytes = Number(result.offsetBytes || 0);
    out.delivery = { returnedBytes, truncated: source.truncated || returnedBytes < originalBytes,
      nextOffsetBytes: offsetBytes + returnedBytes };
    // Provider delivery is a different consumer and must not overwrite handoff
    // delivery bytes (nor be used as a source truncation flag).
    if (result.providerDelivery) out.providerDelivery = result.providerDelivery;
    out.deliveryTruncated ||= returnedBytes < originalBytes;
  }
  out.truncated = source.truncated || source.incomplete || source.entryBudgetExhausted || source.depthTruncated || source.stdoutTruncated || source.stderrTruncated || out.deliveryTruncated;
  if ('stdout' in out) out.stdoutTruncated = source.stdoutTruncated || out.deliveryFields.stdout.omittedCount > 0;
  if ('stderr' in out) out.stderrTruncated = source.stderrTruncated || out.deliveryFields.stderr.omittedCount > 0;
  if (Array.isArray(result.evidence)) {
    out.evidenceCount = result.evidenceCount ?? result.evidence.length;
    out.evidenceTraceDir = result.evidenceTraceDir || null;
    out.deliveryTruncated ||= result.evidence.length > 0;
    out.truncated ||= result.evidence.length > 0;
  }
  return out;
}

export function evidenceDeliveryCounts(evidence = [], originalCount = evidence.length) {
  const deliveredCount = evidence.filter(item => !item.omitted).length;
  return { originalCount, deliveredCount, omittedCount: originalCount - deliveredCount,
    truncated: deliveredCount < originalCount || evidence.some(item => item.truncated || item.deliveryTruncated || item.omitted) };
}
