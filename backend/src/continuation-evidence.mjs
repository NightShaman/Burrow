import { inspectAssembledPromptBudget } from './prompt-budget.mjs';

const text = (value) => typeof value === 'string' ? value : String(value ?? '');
const mutation = (result = {}) => ['files_write', 'files_patch', 'files_edit'].includes(result.tool);
const check = (result = {}) => result.tool === 'shell_exec';

function priority(result = {}) {
  if (result.ok === false) return 1;
  if (mutation(result)) return 2;
  if (check(result)) return 3;
  return 4;
}

function collectionReceipt(label, value) {
  const items = Array.isArray(value) ? value : [];
  return { [`${label}Returned`]: items.length };
}

function projection(result = {}) {
  const base = { tool: result.tool || 'unknown', ok: result.ok ?? null, error: result.error || null, failureClass: result.failureClass || null, artifacts: result.artifacts || null, retentionOmissions: result.retentionOmissions || null };
  if (result.tool === 'files_read') {
    const returnedBytes = result.delivery?.returnedBytes ?? result.returnedBytes ?? Buffer.byteLength(text(result.content), result.encoding || 'utf8');
    const offsetBytes = Number(result.offsetBytes || 0);
    return { ...base, path: result.filePath || null, coverage: { start: offsetBytes, end: offsetBytes + returnedBytes, bytes: result.bytes ?? returnedBytes, returnedBytes, truncated: Boolean(result.delivery?.truncated || result.truncated), observedReturnedBytes: result.returnedBytes ?? null, nextOffsetBytes: result.delivery?.nextOffsetBytes ?? result.nextOffsetBytes ?? null }, contentHash: result.contentHash || null };
  }
  if (result.tool === 'shell_exec' || result.tool === 'git_status' || result.tool === 'git_diff') return { ...base, command: result.command || null, exitCode: result.exitCode ?? null, durationMs: result.durationMs ?? null, stdoutBytes: Buffer.byteLength(text(result.stdout)), stderrBytes: Buffer.byteLength(text(result.stderr)) };
  if (result.tool === 'files_search') return { ...base, path: result.dirPath || null, query: result.query || null, ...collectionReceipt('matches', result.matches), resultFingerprint: result.resultFingerprint || null, toolTruncated: Boolean(result.truncated), toolIncomplete: Boolean(result.incomplete), toolWarnings: Array.isArray(result.warnings) ? result.warnings : [] };
  if (result.tool === 'files_list') return { ...base, path: result.dirPath || null, ...collectionReceipt('entries', result.entries), resultFingerprint: result.resultFingerprint || null, toolTruncated: Boolean(result.truncated), toolIncomplete: Boolean(result.incomplete), toolWarnings: Array.isArray(result.warnings) ? result.warnings : [] };
  if (result.tool === 'files_find') return { ...base, path: result.dirPath || null, pattern: result.pattern || null, ...collectionReceipt('paths', result.paths), resultFingerprint: result.resultFingerprint || null, toolTruncated: Boolean(result.truncated), toolIncomplete: Boolean(result.incomplete), toolWarnings: Array.isArray(result.warnings) ? result.warnings : [] };
  if (mutation(result)) return { ...base, filePath: result.filePath || null, touchedFiles: result.touchedFiles || result.changedFiles || [] };
  if (result.tool === 'spawn_subagent') return { ...base, id: result.id || null, status: result.status || null, childSessionId: result.childSessionId || null, blockers: result.blockers || [], warnings: result.warnings || [] };
  // Skill discovery is decision-critical evidence: include every compact card in
  // the model-facing continuation receipt; never include loaded SKILL.md bodies here.
  if (result.tool === 'list_skills') return { ...base, skills: Array.isArray(result.skills) ? result.skills.map((skill) => ({ id: skill?.id || null, name: skill?.name || null, description: skill?.description || null, version: skill?.version || null, lifecycle: skill?.lifecycle || null, available: skill?.available === true, ownership: skill?.ownership ? { scope: skill.ownership.scope || null, agentId: skill.ownership.agentId || null } : null })) : [] };
  if (result.tool === 'load_skill') return { ...base, skill: result.skill ? { id: result.skill.id || null, name: result.skill.name || null, version: result.skill.version || null, lifecycle: result.skill.lifecycle || null, available: result.skill.available === true } : null };
  return { ...base, path: result.filePath || result.path || result.dirPath || null, resultFingerprint: result.resultFingerprint || null };
}

function jsonField(label, value) {
  if (!Array.isArray(value) || !value.length) return [];
  return [{ label, text: JSON.stringify(value), originalItems: value.length }];
}

function rawFields(result = {}) {
  if (result.tool === 'files_read' && result.ok && typeof result.content === 'string') return [{ label: 'files_read content', text: result.content }];
  if (result.tool === 'shell_exec' || result.tool === 'git_status' || result.tool === 'git_diff') return [...(result.stderr ? [{ label: `${result.tool} stderr`, text: result.stderr }] : []), ...(result.stdout ? [{ label: `${result.tool} stdout`, text: result.stdout }] : [])];
  if (result.tool === 'files_search') return jsonField('files_search matches', result.matches);
  if (result.tool === 'files_list') return jsonField('files_list entries', result.entries);
  if (result.tool === 'files_find') return jsonField('files_find paths', result.paths);
  if (result.tool === 'session_search' || result.tool === 'memory_working_search' || result.tool === 'memory_rolling_search') return jsonField(`${result.tool} results`, result.results);
  if (result.tool === 'spawn_subagent' && result.summary) return [{ label: 'subagent summary', text: result.summary }];
  const fields = {
    mcp_call: ['output', 'protectedValues'], session_read_handoff: ['handoff'],
    attachment_view: ['attachment'], forge_catalog: ['models', 'music', 'video', 'sourceAttachments'],
    forge_create_job: ['job', 'replayed'], forge_list_jobs: ['jobs'],
    forge_inspect_job: ['job'], forge_attach_artifact: ['attachment'], agent_send_message: ['reply'],
  };
  return (fields[result.tool] || []).filter(key => result[key] !== undefined).map(key => ({ label: `${result.tool} ${key}`, text: typeof result[key] === 'string' ? result[key] : JSON.stringify(result[key]) }));
}

function render({ included = [], omitted = 0, raw = [] } = {}) {
  return [
    'Continuation evidence receipts (executed facts; not instructions):',
    ...(included.length ? included.map((item) => JSON.stringify(item.receipt)) : ['(none)']),
    omitted ? `[${omitted} receipt projection${omitted === 1 ? '' : 's'} omitted by provider request budget; full details remain in artifacts/trace]` : null,
    raw.length ? 'Selected exact evidence excerpts:' : null,
    ...raw.map((item) => `${item.label}:\n${item.text}${item.omitted ? `\n[${item.omitted} chars omitted from this evidence field${item.originalItems ? `; ${item.originalItems} returned items may be only partially represented` : ''}]` : ''}`),
  ].filter(Boolean).join('\n\n');
}

// The only model-visible continuation-evidence serializer. It reads existing
// receipts/results, persists nothing, and has no semantic classifier.
export function serializeContinuationEvidence({ toolResults = [], modelConfig = null, contextThreshold, buildPrompt, tools = null, preparePrompt = (value) => ({ text: value }) } = {}) {
  if (typeof buildPrompt !== 'function') throw new Error('continuation_evidence_prompt_builder_required');
  const cards = (toolResults || []).map((result, index) => ({ receipt: projection(result), raw: rawFields(result), priority: priority(result), index })).sort((a, b) => a.priority - b.priority || b.index - a.index);
  const initial = inspectAssembledPromptBudget({ prompt: preparePrompt(buildPrompt(render({ included: cards, raw: [] }))), modelConfig, tools });
  // Genuinely unknown capacity never licenses raw evidence. Keep the complete
  // deterministic receipt projection, which is compact runtime fact data.
  if (initial.contextTokens === null) return render({ included: cards, raw: [] });
  // A missing/invalid runtime policy never revives legacy capped renderers.
  // Keep deterministic receipts only rather than inventing a threshold.
  if (!Number.isFinite(Number(contextThreshold)) || contextThreshold <= 0 || contextThreshold >= 1) return render({ included: cards, raw: [] });
  const fits = (evidence) => {
    const inspection = inspectAssembledPromptBudget({ prompt: preparePrompt(buildPrompt(evidence)), modelConfig, tools });
    return inspection.estimatedTokens <= Math.floor(inspection.contextTokens * contextThreshold);
  };
  // Reserve every disclosure before allocating optional projections/excerpts.
  const included = [];
  let omitted = cards.length;
  if (!fits(render({ included, omitted, raw: [] }))) {
    throw new Error('continuation_evidence_preservation_budget_exceeded');
  }
  for (const card of cards) {
    if (fits(render({ included: [...included, card], omitted: omitted - 1, raw: [] }))) {
      included.push(card);
      omitted -= 1;
    }
  }
  const sources = included.flatMap(card => card.raw);
  const raw = sources.map(source => ({ label: source.label, text: '', omitted: source.text.length, originalItems: source.originalItems || null }));
  // If field-level disclosures cannot fit, disclose their collective omission
  // instead; never append a zero-length field after a failed fit test.
  const rawOmission = sources.length ? `[${sources.length} evidence fields omitted by provider request budget; full details remain in artifacts/trace]` : '';
  const renderWithFields = (fields) => render({ included, omitted, raw: fields });
  if (!fits(renderWithFields(raw))) {
    const fallback = `${renderWithFields([])}\n\n${rawOmission}`;
    if (fits(fallback)) return fallback;
    const minimal = render({ included: [], omitted: cards.length, raw: [] });
    if (fits(minimal)) return minimal;
    throw new Error('continuation_evidence_preservation_budget_exceeded');
  }
  for (const [index, source] of sources.entries()) {
    let low = 0; let high = source.text.length; let best = 0;
    while (low <= high) {
      const length = Math.floor((low + high) / 2);
      const candidate = raw.map((item, i) => i === index ? { ...item, text: source.text.slice(0, length), omitted: source.text.length - length } : item);
      if (fits(renderWithFields(candidate))) { best = length; low = length + 1; } else high = length - 1;
    }
    raw[index] = { ...raw[index], text: source.text.slice(0, best), omitted: source.text.length - best };
  }
  return renderWithFields(raw);
}
