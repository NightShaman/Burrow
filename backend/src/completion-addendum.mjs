import { changedPathsFromToolResults, summarizeToolResults } from './runtime-result-shapes.mjs';

const MAX_ITEMS = 8;
const MAX_CHARS = 1_600;
const MUTATION_TOOLS = new Set(['files_write', 'files_edit', 'files_patch']);
const INSPECTION_TOOLS = new Set(['files_read', 'files_list', 'files_find', 'files_inspect', 'files_search', 'git_status', 'git_diff', 'shell_exec', 'mcp_call', 'spawn_subagent']);

function unique(values = []) { return [...new Set(values.filter(Boolean))].slice(0, MAX_ITEMS); }
function text(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }
function checkResult(result) { return result?.tool === 'shell_exec' && (result.verificationCheck === true || /(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:check|test|lint|build)|\b(?:check|test|lint|build)\b/i.test(String(result.command || ''))); }
function mcpLabel(result) { return result?.mcpToolName || result?.toolName || 'MCP tool'; }

export function completionEvidence({ toolResults = [], verification = null, decision = null, validation = null } = {}) {
  const results = Array.isArray(toolResults) ? toolResults : [];
  const successful = results.filter((result) => result?.ok === true);
  const failed = results.filter((result) => result?.ok === false);
  const changedFiles = unique(changedPathsFromToolResults(results));
  const checks = successful.filter(checkResult);
  const mcp = results.filter((result) => result?.tool === 'mcp_call');
  const inspected = successful.filter((result) => INSPECTION_TOOLS.has(result?.tool) && !MUTATION_TOOLS.has(result?.tool));
  const repaired = results.some((result) => result?.mutationRepair || result?.verificationRepair)
    || results.some((result) => result?.failureClass && failed.length && successful.length);
  return {
    meaningful: Boolean(changedFiles.length || checks.length || mcp.length || failed.length || verification?.required || validation),
    changedFiles,
    checks: checks.map((result) => ({ command: text(result.command) || 'check', ok: result.ok === true })).slice(0, MAX_ITEMS),
    mcp: mcp.map((result) => ({ name: mcpLabel(result), ok: result.ok === true, provider: result.provider || null })).slice(0, MAX_ITEMS),
    inspected: inspected.length,
    failed: failed.map((result) => text(result.error || result.reason || result.tool || 'operation failed')).filter(Boolean).slice(0, MAX_ITEMS),
    repaired,
    verification: verification ? { required: Boolean(verification.required), ok: verification.ok === true, reason: verification.reason || null } : null,
    validation: validation || null,
    decision: decision || null,
  };
}

export function renderCompletionAddendum(evidence = null) {
  if (!evidence?.meaningful) return '';
  const lines = ['Completion evidence:'];
  if (evidence.changedFiles.length) lines.push(`- Changed: ${evidence.changedFiles.join(', ')}`);
  if (evidence.checks.length) lines.push(`- Validation: ${evidence.checks.map((check) => `${check.command} (${check.ok ? 'passed' : 'failed'})`).join('; ')}`);
  if (evidence.mcp.length) lines.push(`- MCP: ${evidence.mcp.map((call) => `${call.name}${call.provider ? ` via ${call.provider}` : ''} (${call.ok ? 'succeeded' : 'failed'})`).join('; ')}`);
  if (evidence.inspected && !evidence.changedFiles.length && !evidence.checks.length && !evidence.mcp.length) lines.push(`- Inspected: ${evidence.inspected} operation${evidence.inspected === 1 ? '' : 's'}`);
  if (evidence.failed.length) lines.push(`- Issue: ${evidence.failed.join('; ')}`);
  if (evidence.verification?.required && evidence.verification.ok !== true) lines.push(`- Caveat: verification was not confirmed${evidence.verification.reason ? ` (${evidence.verification.reason})` : ''}.`);
  if (evidence.repaired) lines.push('- Caveat: a failed attempt was repaired; the final state is reported only from the successful evidence above.');
  return lines.join('\n').slice(0, MAX_CHARS);
}

export function appendCompletionAddendum(answerText, evidence = null) {
  const addendum = renderCompletionAddendum(evidence);
  if (!addendum) return answerText;
  const answer = text(answerText);
  // Avoid duplicate ceremony when the model already included the same evidence.
  if (answer && /completion evidence|changed:|validation:|verification passed|verification failed/i.test(answer)) return answerText;
  return [answerText, addendum].filter(Boolean).join('\n\n');
}

export const __test__ = { checkResult, mcpLabel };
