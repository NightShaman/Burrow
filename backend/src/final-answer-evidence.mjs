// Deterministic projection of existing tool receipts for the compatibility
// final-answer completion. This owns no storage and performs no interpretation.

function text(value) { return typeof value === 'string' ? value : String(value ?? ''); }
function isMutation(result = {}) { return ['files_write', 'files_patch', 'files_edit'].includes(result.tool); }
function isCheck(result = {}) { return result.tool === 'shell_exec'; }

function priority(result = {}) {
  if (result.ok === false) return 1;
  if (isMutation(result)) return 2;
  if (isCheck(result)) return 3;
  return 4;
}

function readFields(result = {}) {
  const returnedBytes = result.returnedBytes ?? Buffer.byteLength(text(result.content), result.encoding || 'utf8');
  const bytes = result.bytes ?? returnedBytes;
  const offsetBytes = Number(result.offsetBytes || 0);
  return {
    path: result.filePath || null,
    coverage: { start: offsetBytes, end: offsetBytes + returnedBytes, bytes, returnedBytes, truncated: Boolean(result.truncated), nextOffsetBytes: result.nextOffsetBytes ?? null },
    contentHash: result.contentHash || null,
    artifacts: result.artifacts || null,
  };
}

function receiptFields(result = {}) {
  return {
    tool: result.tool || 'unknown',
    ok: result.ok ?? null,
    ...(result.tool === 'files_read' ? readFields(result) : {}),
    ...(result.tool === 'shell_exec' ? { command: result.command || null, exitCode: result.exitCode ?? null, durationMs: result.durationMs ?? null, stdoutBytes: Buffer.byteLength(text(result.stdout)), stderrBytes: Buffer.byteLength(text(result.stderr)), artifacts: result.artifacts || null } : {}),
    ...(isMutation(result) ? { filePath: result.filePath || null, touchedFiles: result.touchedFiles || result.changedFiles || [], failureClass: result.failureClass || null, artifacts: result.artifacts || null } : {}),
    ...(result.tool === 'spawn_subagent' ? { id: result.id || null, status: result.status || null, childSessionId: result.childSessionId || null, blockers: result.blockers || [], warnings: result.warnings || [], artifacts: result.artifacts || null } : {}),
    error: result.error || null,
  };
}

function rawFields(result = {}) {
  if (result.tool === 'files_read' && result.ok && typeof result.content === 'string') return [{ label: 'files_read content', text: result.content }];
  if (result.tool === 'shell_exec') return [
    ...(result.stderr ? [{ label: 'shell_exec stderr', text: result.stderr }] : []),
    ...(result.stdout ? [{ label: 'shell_exec stdout', text: result.stdout }] : []),
  ];
  if (result.tool === 'spawn_subagent') return [
    ...(result.summary ? [{ label: 'subagent summary', text: result.summary }] : []),
  ];
  return [];
}

function card(result) {
  return { receipt: receiptFields(result), raw: rawFields(result), priority: priority(result) };
}

function render({ verification = null, included = [], omitted = 0, raw = [] } = {}) {
  return [
    'Verification receipt:', JSON.stringify(verification || null),
    'Executed receipt projections:',
    ...(included.length ? included.map((item) => JSON.stringify(item.receipt)) : ['(none)']),
    omitted ? `Receipt projections omitted because the final request budget is exhausted: ${omitted}` : null,
    raw.length ? 'Exact raw evidence excerpts:' : null,
    ...raw.map((item) => `${item.label}:\n${item.text}${item.omitted ? `\n[${item.omitted} chars omitted from this evidence field]` : ''}`),
  ].filter(Boolean).join('\n\n');
}

// `fits` must measure the actual provider request including the final-answer
// prompt. Selection is deterministic by receipt priority and original order.
export async function serializeFinalAnswerEvidence({ toolResults = [], verification = null, fits, allowRaw = true } = {}) {
  if (typeof fits !== 'function') throw new Error('final_answer_evidence_fits_required');
  // Receipt projections are the existing compact runtime facts. They remain
  // available even when model capacity is genuinely unknown; only raw source
  // excerpts require a measured provider budget.
  const included = (toolResults || []).map(card).sort((a, b) => a.priority - b.priority);
  const omitted = 0;
  const raw = [];
  if (!allowRaw) return render({ verification, included, omitted, raw });
  for (const item of included) {
    for (const source of item.raw) {
      let low = 0;
      let high = source.text.length;
      let best = 0;
      while (low <= high) {
        const length = Math.floor((low + high) / 2);
        const candidateRaw = [...raw, { label: source.label, text: source.text.slice(0, length), omitted: source.text.length - length }];
        if (await fits(render({ verification, included, omitted, raw: candidateRaw }))) { best = length; low = length + 1; }
        else high = length - 1;
      }
      if (best > 0) raw.push({ label: source.label, text: source.text.slice(0, best), omitted: source.text.length - best });
    }
  }
  return render({ verification, included, omitted, raw });
}
