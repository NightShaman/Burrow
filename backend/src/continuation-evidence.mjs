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
  return { [`${label}Returned`]: items.length, [`${label}TruncatedAtTool`]: null };
}

function projection(result = {}) {
  const base = { tool: result.tool || 'unknown', ok: result.ok ?? null, error: result.error || null, failureClass: result.failureClass || null, artifacts: result.artifacts || null };
  if (result.tool === 'files_read') {
    const returnedBytes = result.returnedBytes ?? Buffer.byteLength(text(result.content), result.encoding || 'utf8');
    const offsetBytes = Number(result.offsetBytes || 0);
    return { ...base, path: result.filePath || null, coverage: { start: offsetBytes, end: offsetBytes + returnedBytes, bytes: result.bytes ?? returnedBytes, returnedBytes, truncated: Boolean(result.truncated), nextOffsetBytes: result.nextOffsetBytes ?? null }, contentHash: result.contentHash || null };
  }
  if (result.tool === 'shell_exec' || result.tool === 'git_status' || result.tool === 'git_diff') return { ...base, command: result.command || null, exitCode: result.exitCode ?? null, durationMs: result.durationMs ?? null, stdoutBytes: Buffer.byteLength(text(result.stdout)), stderrBytes: Buffer.byteLength(text(result.stderr)) };
  if (result.tool === 'files_search') return { ...base, path: result.dirPath || null, query: result.query || null, ...collectionReceipt('matches', result.matches), resultFingerprint: result.resultFingerprint || null, toolTruncated: Boolean(result.truncated) };
  if (result.tool === 'files_list') return { ...base, path: result.dirPath || null, ...collectionReceipt('entries', result.entries), resultFingerprint: result.resultFingerprint || null, toolTruncated: Boolean(result.truncated) };
  if (result.tool === 'files_find') return { ...base, path: result.dirPath || null, pattern: result.pattern || null, ...collectionReceipt('paths', result.paths), resultFingerprint: result.resultFingerprint || null, toolTruncated: Boolean(result.truncated) };
  if (mutation(result)) return { ...base, filePath: result.filePath || null, touchedFiles: result.touchedFiles || result.changedFiles || [] };
  if (result.tool === 'spawn_subagent') return { ...base, id: result.id || null, status: result.status || null, childSessionId: result.childSessionId || null, blockers: result.blockers || [], warnings: result.warnings || [] };
  // Skill discovery is decision-critical evidence: include bounded cards in the
  // model-facing continuation receipt. The catalog is already bounded by the
  // executor/result shape; never include loaded SKILL.md bodies here.
  if (result.tool === 'list_skills') return { ...base, skills: Array.isArray(result.skills) ? result.skills.slice(0, 20).map((skill) => ({ id: skill?.id || null, name: skill?.name || null, description: skill?.description || null, version: skill?.version || null, lifecycle: skill?.lifecycle || null, available: skill?.available === true, ownership: skill?.ownership ? { scope: skill.ownership.scope || null, agentId: skill.ownership.agentId || null } : null })) : [] };
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
  return [];
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
export function serializeContinuationEvidence({ toolResults = [], modelConfig = null, contextThreshold, buildPrompt, tools = null } = {}) {
  if (typeof buildPrompt !== 'function') throw new Error('continuation_evidence_prompt_builder_required');
  const cards = (toolResults || []).map((result, index) => ({ receipt: projection(result), raw: rawFields(result), priority: priority(result), index })).sort((a, b) => a.priority - b.priority || b.index - a.index);
  const initial = inspectAssembledPromptBudget({ prompt: { text: buildPrompt(render({ included: cards, raw: [] })) }, modelConfig, tools });
  // Genuinely unknown capacity never licenses raw evidence. Keep the complete
  // deterministic receipt projection, which is compact runtime fact data.
  if (initial.contextTokens === null) return render({ included: cards, raw: [] });
  // A missing/invalid runtime policy never revives legacy capped renderers.
  // Keep deterministic receipts only rather than inventing a threshold.
  if (!Number.isFinite(Number(contextThreshold)) || contextThreshold <= 0 || contextThreshold >= 1) return render({ included: cards, raw: [] });
  const fits = (evidence) => {
    const inspection = inspectAssembledPromptBudget({ prompt: { text: buildPrompt(evidence) }, modelConfig, tools });
    return inspection.estimatedTokens <= Math.floor(inspection.contextTokens * contextThreshold);
  };
  const included = [];
  let omitted = 0;
  for (const card of cards) {
    if (fits(render({ included: [...included, card], omitted, raw: [] }))) included.push(card);
    else omitted += 1;
  }
  const base = inspectAssembledPromptBudget({ prompt: { text: buildPrompt(render({ included, omitted, raw: [] })) }, modelConfig, tools });
  const raw = [];
  for (const card of included) for (const source of card.raw) {
    let low = 0; let high = source.text.length; let best = 0;
    while (low <= high) {
      const length = Math.floor((low + high) / 2);
      const candidate = [...raw, { label: source.label, text: source.text.slice(0, length), omitted: source.text.length - length, originalItems: source.originalItems || null }];
      if (fits(render({ included, omitted, raw: candidate }))) { best = length; low = length + 1; } else high = length - 1;
    }
    if (best) raw.push({ label: source.label, text: source.text.slice(0, best), omitted: source.text.length - best, originalItems: source.originalItems || null });
  }
  return render({ included, omitted, raw });
}
