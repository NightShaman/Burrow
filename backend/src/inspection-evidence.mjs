import { promises as fs } from 'node:fs';
import path from 'node:path';
import { runExec } from './harness/exec.mjs';
import { readFileEnvelope } from './harness/read-file.mjs';
const DEFAULT_INSPECTION_FILES = [
  'package.json',
  'README.md',
  'scripts/burrow-ui.mjs',
  'tests/ui-server.test.mjs',
  'src/app-runtime.mjs',
  'src/prompt-assembler.mjs',
];

const UI_INSPECTION_HINT = /\b(ui|interface|screen|page|frontend|front-end|html|css|style|layout|visual|rendered|browser)\b/i;
const UI_SOURCE_HINT = /(?:scripts\/burrow-ui\.mjs|tests\/ui-server\.test\.mjs|src\/chat-turn-controller\.mjs)/i;

function isUiInspectionRequest(message = '') {
  return UI_INSPECTION_HINT.test(String(message || ''));
}

function hasTargetedUiEvidence(toolResults = []) {
  return toolResults.some((result) => {
    if (!result?.ok) return false;
    if (result.tool === 'files_read' && UI_SOURCE_HINT.test(String(result.filePath || ''))) return true;
    if (result.tool === 'shell_exec') {
      const command = String(result.command || '');
      const stdout = String(result.stdout || '');
      const outputLooksLikeUiSource = /(<html|<main|conversation-pane|sessionTranscript|function page\(|createServer\()/i.test(stdout);
      return UI_SOURCE_HINT.test(command) && outputLooksLikeUiSource;
    }
    return false;
  });
}

function targetedUiInspectionMissingFallback({ message = '', toolResults = [] } = {}) {
  if (!isUiInspectionRequest(message)) return null;
  if (hasTargetedUiEvidence(toolResults)) return null;
  if (!hasExecutedInspectionEvidence(toolResults)) return null;
  return 'I inspected the available local context, but I did not find targeted UI source evidence. I should not claim the project only exposes README.md/package.json as fact; the workspace root may be wrong or the UI source is outside the inspected root.';
}

function isMutationToolResult(result = {}) {
  return Boolean(result?.ok && ['files_write', 'files_patch'].includes(result.tool));
}

export function shouldFollowReadOnlyInspection({ mode, ok, model, proposalExecution } = {}) {
  if (!ok || mode !== 'model' || !model?.ok) return false;
  const toolResults = proposalExecution?.toolResults || [];
  if (!toolResults.some((result) => result?.ok && ['files_read', 'shell_exec'].includes(result.tool))) return false;
  if (toolResults.some(isMutationToolResult)) return false;
  return true;
}

const READ_FILE_EVIDENCE_CHARS = 32000;

function readCoverageLines(result = {}) {
  if (!result?.ok) return [];
  // A filesystem read and a model-delivered excerpt are different facts. Never
  // claim the model saw a complete range when prompt compaction withheld it.
  const offsetBytes = Number(result.offsetBytes || 0);
  const rawReturnedBytes = result.returnedBytes ?? Buffer.byteLength(String(result.content || ''), result.encoding || 'utf8');
  const deliveredBytes = result.delivery?.returnedBytes ?? rawReturnedBytes;
  const totalBytes = result.bytes ?? rawReturnedBytes;
  const truncated = Boolean(result.delivery?.truncated ?? result.truncated ?? rawReturnedBytes < totalBytes);
  const nextOffsetBytes = result.delivery?.nextOffsetBytes ?? result.nextOffsetBytes ?? offsetBytes + deliveredBytes;
  const rawComplete = offsetBytes + rawReturnedBytes >= totalBytes;
  return [
    `Delivered coverage: bytes ${offsetBytes}-${offsetBytes + deliveredBytes} of ${totalBytes}${truncated ? ' (partial)' : ' (complete)'}`,
    rawComplete && truncated ? `The tool read the full range, but this continuation only includes a bounded excerpt.` : null,
    truncated ? `Partial result: continue with files_read using offsetBytes: ${nextOffsetBytes} to read bytes ${nextOffsetBytes}-${totalBytes}. Do not reread the same range unless you have a specific reason.` : null,
  ].filter(Boolean);
}

function summarizeInspectionResult(result = {}, { readChars = READ_FILE_EVIDENCE_CHARS, execStdoutChars = 12000, execStderrChars = 4000 } = {}) {
  if (result.tool === 'files_read') {
    return [
      `Tool: files_read`,
      `OK: ${result.ok ? 'true' : 'false'}`,
      `Path: ${result.filePath || 'unknown'}`,
      ...readCoverageLines(result),
      result.ok ? `Content${result.truncated || String(result.content || '').length > readChars ? ` (first ${readChars} chars)` : ''}:\n${String(result.content || '').slice(0, readChars)}` : `Error: ${result.error || 'read failed'}`,
    ].join('\n');
  }
  if (result.tool === 'memory_working_search') {
    const results = (result.results || []).slice(0, 8).map((item) => [
      `[${item.kind || 'memory'}] ${item.title || item.id || 'untitled'}`,
      item.project ? `Project: ${item.project}` : null,
      item.content ? `Content:\n${String(item.content).slice(0, 4000)}` : null,
      item.sourceRef ? `Source: ${item.sourceRef}` : (item.sourceRefs?.length ? `Sources: ${item.sourceRefs.join(', ')}` : null),
    ].filter(Boolean).join('\n')).join('\n---\n');
    return [
      `Tool: ${result.tool}`,
      `OK: ${result.ok ? 'true' : 'false'}`,
      `Query: ${result.query || ''}`,
      result.project ? `Project: ${result.project}` : null,
      result.requestedProject ? `Requested project: ${result.requestedProject}` : null,
      `Results: ${result.resultCount ?? (result.results || []).length}`,
      results || '(no matching memory rows)',
      result.error ? `Error: ${result.error}` : null,
    ].filter(Boolean).join('\n');
  }
  if (result.tool === 'memory_rolling_search') {
    const results = (result.results || []).slice(0, 8).map((item) => [
      `[warm] ${item.title || item.id || 'untitled'}`,
      item.project ? `Project: ${item.project}` : null,
      item.summary ? `Summary:\n${String(item.summary).slice(0, 4000)}` : null,
      `Recency: last seen ${item.lastSeen || 'unknown'}; recurrence ${item.recurrence || 0}`,
      item.evidence ? `Evidence: ${item.evidence}` : null,
      item.recentRefs?.length ? `Recent refs: ${item.recentRefs.join(', ')}` : null,
    ].filter(Boolean).join('\n')).join('\n---\n');
    return [
      `Tool: ${result.tool}`,
      `OK: ${result.ok ? 'true' : 'false'}`,
      `Query: ${result.query || ''}`,
      result.project ? `Project: ${result.project}` : null,
      `Results: ${result.resultCount ?? (result.results || []).length}`,
      results || '(no matching warm continuity cards; this absence is not evidence that profile identity, role, persona, current user intent, or current-task context is missing)',
      result.error ? `Error: ${result.error}` : null,
    ].filter(Boolean).join('\n');
  }
  if (result.tool === 'agent_send_message') {
    return [
      'Tool: agent_send_message',
      `OK: ${result.ok ? 'true' : 'false'}`,
      `Recipient: ${result.recipientAgentId || 'unknown'}`,
      `Mode: ${result.messageMode || 'deliver'}`,
      result.reply?.ok ? `Recipient reply:\n${String(result.reply.content || '').slice(0, 12000) || '(reply persisted but content unavailable)'}` : null,
      result.reply?.error ? `Reply error: ${result.reply.error}` : null,
      result.error ? `Error: ${result.error}` : null,
    ].filter(Boolean).join('\n');
  }
  if (result.tool === 'memory_working_write') {
    return [
      `Tool: ${result.tool}`,
      `OK: ${result.ok ? 'true' : 'false'}`,
      result.record?.id ? `Record: ${result.record.id}` : null,
      result.memoryId ? `Memory: ${result.memoryId}` : null,
      result.project ? `Project: ${result.project}` : null,
      result.error ? `Error: ${result.error}` : null,
    ].filter(Boolean).join('\n');
  }
  if (result.tool === 'files_list') {
    const entries = (result.entries || []).slice(0, 200).map((entry) => `${entry.type === 'directory' ? 'dir' : 'file'} ${entry.path || 'unknown'}`).join('\n');
    return [
      'Tool: files_list',
      `OK: ${result.ok ? 'true' : 'false'}`,
      `Directory: ${result.dirPath || 'unknown'}`,
      `Entries returned: ${(result.entries || []).length}${result.truncated ? ' (truncated)' : ''}`,
      result.resultFingerprint ? `Observed state: ${result.resultFingerprint}` : null,
      entries ? `Entries:\n${entries}` : '(no entries returned)',
      result.error ? `Error: ${result.error}` : null,
    ].filter(Boolean).join('\n');
  }
  if (result.tool === 'files_find') {
    const paths = (result.paths || []).slice(0, 200).join('\n');
    return [
      'Tool: files_find',
      `OK: ${result.ok ? 'true' : 'false'}`,
      `Directory: ${result.dirPath || 'unknown'}`,
      `Pattern: ${result.pattern || '*'}`,
      `Paths returned: ${(result.paths || []).length}${result.truncated ? ' (truncated)' : ''}`,
      result.resultFingerprint ? `Observed state: ${result.resultFingerprint}` : null,
      paths ? `Paths:\n${paths}` : '(no paths returned)',
      result.error ? `Error: ${result.error}` : null,
    ].filter(Boolean).join('\n');
  }
  if (result.tool === 'files_inspect') {
    return [
      'Tool: files_inspect',
      `OK: ${result.ok ? 'true' : 'false'}`,
      `Path: ${result.path || 'unknown'}`,
      `Exists: ${result.exists === true ? 'true' : 'false'}`,
      result.type ? `Type: ${result.type}` : null,
      result.size == null ? null : `Size: ${result.size}`,
      result.modifiedAt ? `Modified: ${result.modifiedAt}` : null,
      result.resultFingerprint ? `Observed state: ${result.resultFingerprint}` : null,
      result.error ? `Error: ${result.error}` : null,
    ].filter(Boolean).join('\n');
  }
  if (result.tool === 'files_search') {
    const matches = (result.matches || []).slice(0, 200).map((match) => `${match.filePath || 'unknown'}:${match.line ?? '?'}: ${match.text || ''}`).join('\n');
    return [
      'Tool: files_search',
      `OK: ${result.ok ? 'true' : 'false'}`,
      `Directory: ${result.dirPath || 'unknown'}`,
      `Query: ${result.query || ''}`,
      `Matches returned: ${(result.matches || []).length}${result.truncated ? ' (truncated)' : ''}`,
      result.resultFingerprint ? `Observed state: ${result.resultFingerprint}` : null,
      matches ? `Matches:\n${matches}` : '(no matches returned)',
      result.error ? `Error: ${result.error}` : null,
    ].filter(Boolean).join('\n');
  }
  if (result.tool === 'git_status' || result.tool === 'git_diff') {
    const stdout = String(result.stdout || '');
    return [
      `Tool: ${result.tool}`,
      `OK: ${result.ok ? 'true' : 'false'}`,
      `Directory: ${result.dirPath || result.cwd || 'unknown'}`,
      `Exit code: ${result.exitCode ?? 'unknown'}`,
      result.resultFingerprint ? `Observed state: ${result.resultFingerprint}` : null,
      `Output:\n${stdout || '(no output)'}`,
      result.stderr ? `Stderr:\n${String(result.stderr || '')}` : null,
      result.error ? `Error: ${result.error}` : null,
    ].filter(Boolean).join('\n');
  }
  if (result.tool === 'shell_exec') {
    const stdout = String(result.stdout || '');
    const originalChars = Number(result.stdoutOriginalChars) || stdout.length;
    const deliveredChars = Math.min(stdout.length, execStdoutChars);
    return [
      `Tool: shell_exec`,
      `OK: ${result.ok ? 'true' : 'false'}`,
      `Command: ${result.command || 'unknown'}`,
      `Exit code: ${result.exitCode ?? 'unknown'}`,
      `Stdout delivery: first ${deliveredChars} of ${originalChars} chars${deliveredChars < originalChars ? ' (remainder omitted from this continuation prompt)' : ''}`,
      `Stdout:\n${stdout.slice(0, execStdoutChars)}`,
      result.stderr ? `Stderr:\n${String(result.stderr || '').slice(0, execStderrChars)}` : null,
      result.error ? `Error: ${result.error}` : null,
    ].filter(Boolean).join('\n');
  }
  if (result.tool === 'spawn_subagent') {
    const evidence = (result.evidence || []).slice(0, 8).map((item) => {
      if (item?.tool === 'files_read') {
        const returnedBytes = item.returnedBytes ?? Buffer.byteLength(String(item.content || ''), item.encoding || 'utf8');
        const totalBytes = item.bytes ?? returnedBytes;
        return [
          'Evidence tool: files_read',
          `Path: ${item.filePath || 'unknown'}`,
          `Coverage: bytes ${item.offsetBytes || 0}-${(item.offsetBytes || 0) + returnedBytes} of ${totalBytes}${item.truncated ? ' (truncated)' : ''}`,
          item.error ? `Error: ${item.error}` : null,
          item.ok ? `Content excerpt:\n${String(item.content || '').slice(0, 6000)}` : null,
        ].filter(Boolean).join('\n');
      }
      if (item?.tool === 'files_list') {
        return [
          'Evidence tool: files_list',
          `Dir: ${item.dirPath || '.'}`,
          `Files:\n${(item.files || []).slice(0, 200).join('\n')}`,
          item.truncated ? 'List truncated: true' : null,
        ].filter(Boolean).join('\n');
      }
      return JSON.stringify(item).slice(0, 6000);
    }).join('\n---\n');
    return [
      'Tool: spawn_subagent',
      `OK: ${result.ok ? 'true' : 'false'}`,
      `ID: ${result.id || 'unknown'}`,
      `Status: ${result.status || 'unknown'}`,
      result.target?.root ? `Target root: ${result.target.root}` : null,
      result.childSessionId ? `Child session: ${result.childSessionId}` : null,
      result.summary ? `Subagent findings:\n${String(result.summary).slice(0, 6000)}` : null,
      result.blockers?.length ? `Blockers: ${result.blockers.join(', ')}` : null,
      result.warnings?.length ? `Warnings: ${result.warnings.join(', ')}` : null,
      evidence ? `Evidence:\n${evidence}` : null,
    ].filter(Boolean).join('\n');
  }
  return '';
}

export function inspectionResultSummary(toolResults = [], options = {}) {
  return (toolResults || [])
    .map((result) => summarizeInspectionResult(result, options))
    .filter(Boolean)
    .join('\n\n---\n\n');
}

// Tool artifacts retain full output. Follow-up prompts must not: resending every
// large read/exec result on every tool call can grow a chat loop until V8 dies.
// But recency is not evidence authority: keep compact references to the whole
// observed tool chain, and spend the bulky excerpt budget on material evidence
// rather than blindly dropping anything older than N newer calls.
// Tool calls are not limited by count. A long investigation is legitimate as
// long as each round adds material evidence. Retained receipts and rendered
// prompt evidence have byte budgets. Repeated observations are recorded as
export function hasExecutedInspectionEvidence(toolResults = []) {
  return toolResults.some((result) => result?.ok && (result.tool === 'files_read' || result.tool === 'shell_exec'));
}

export function hasExecutedReadFileEvidence(toolResults = []) {
  return toolResults.some((result) => result?.ok && result.tool === 'files_read');
}

function normalizeCanonicalInspectionPath(filePath = '') {
  const value = String(filePath || '').trim();
  if (!value || !path.isAbsolute(value)) return null;
  return path.resolve(value);
}

function canonicalInspectionTargets(inspectionTargets = []) {
  return [...new Set((inspectionTargets || []).map(normalizeCanonicalInspectionPath).filter(Boolean))];
}

function hasTargetedFileEvidence(toolResults = [], target = '') {
  const normalizedTarget = normalizeCanonicalInspectionPath(target);
  if (!normalizedTarget) return false;
  return toolResults.some((result) => {
    if (!result?.ok) return false;
    if (result.tool !== 'files_read') return false;
    return normalizeCanonicalInspectionPath(result.filePath) === normalizedTarget;
  });
}

function invalidInspectionTargets(inspectionTargets = []) {
  return [...new Set((inspectionTargets || [])
    .map((target) => String(target || '').trim())
    .filter((target) => target && !normalizeCanonicalInspectionPath(target)))];
}

function missingInspectionTargets(toolResults = [], inspectionTargets = []) {
  return [
    ...invalidInspectionTargets(inspectionTargets),
    ...canonicalInspectionTargets(inspectionTargets).filter((target) => !hasTargetedFileEvidence(toolResults, target)),
  ];
}

export function shouldForceInspectionEvidence({ inspectionRequired = false, inspectionTargets = [], proposalExecution, message = '' } = {}) {
  if (!inspectionRequired) return false;
  const toolResults = proposalExecution?.toolResults || [];
  if (isUiInspectionRequest(message) && !hasTargetedUiEvidence(toolResults)) return true;
  if (missingInspectionTargets(toolResults, inspectionTargets).length) return true;
  return !hasExecutedInspectionEvidence(toolResults);
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function defaultInspectionFileList(workspaceRoot) {
  if (!workspaceRoot) return [];
  const selected = [];
  for (const file of DEFAULT_INSPECTION_FILES) {
    if (await pathExists(path.join(workspaceRoot, file))) selected.push(file);
  }
  return selected;
}

export async function runDefaultReadOnlyInspection({ workspaceRoot, rootDir, dataRoot = null, traceLogger, inspectionTargets = [] } = {}) {
  if (!workspaceRoot) return [];
  const workspaceBoundary = workspaceRoot || rootDir || process.cwd();
  const files = await defaultInspectionFileList(workspaceRoot);
  const targetFiles = canonicalInspectionTargets(inspectionTargets);
  const defaultFiles = files.slice(0, 8).map((filePath) => path.join(workspaceRoot, filePath));
  const readFiles = [...new Set([...targetFiles, ...defaultFiles])];
  const results = [];
  const runtimeOwnedPaths = ['traces', 'sessions', 'work-items', 'handoffs', 'memory', 'profile', 'skills', 'tools', 'artifacts', 'workbench-verify', 'cache', 'node_modules', '.git', 'coverage', 'dist', 'build', '.cache', 'tmp'];
  if (dataRoot) {
    const relativeDataRoot = path.relative(path.resolve(workspaceRoot), path.resolve(dataRoot)).split(path.sep).join('/');
    if (relativeDataRoot && !relativeDataRoot.startsWith('../') && relativeDataRoot !== '..' && !path.isAbsolute(relativeDataRoot)) {
      runtimeOwnedPaths.push(relativeDataRoot);
    }
  }
  const prunePaths = [...new Set(runtimeOwnedPaths)].map((name) => `-path './${name}'`).join(' -o ');
  const listingCommand = `find . -maxdepth 3 \\( ${prunePaths} \\) -prune -o -type f -print | sed 's#^./##' | sort | head -120`;
  results.push(await runExec({ command: listingCommand, cwd: workspaceRoot, traceLogger, artifactPrefix: 'default-inspection-list' }));
  for (const filePath of readFiles) {
    results.push(await readFileEnvelope({
      filePath,
      workspaceRoot: workspaceBoundary,
      traceLogger,
      artifactPrefix: `default-inspection-read-${path.relative(workspaceRoot, filePath).replace(/[^a-z0-9_.-]+/gi, '-')}`,
    }));
  }
  return results;
}

export function pendingInspectionFallback({ proposal, proposalExecution } = {}) {
  if (!proposal?.actions?.length) return null;
  if ((proposalExecution?.executed || 0) > 0) return null;
  const skipped = proposalExecution?.skipped || [];
  const readOnlySkipped = skipped.filter((item) => item.tool === 'files_read' || item.tool === 'shell_exec');
  if (!readOnlySkipped.length) return null;
  const answer = String(proposal.answerText || '').trim();
  const pendingOnly = /^inspect(?:ing)?\b/i.test(answer) || /^check(?:ing)?\b/i.test(answer) || /^read(?:ing)?\b/i.test(answer);
  if (!pendingOnly) return null;
  const reasons = readOnlySkipped.map((item) => `${item.tool}:${item.status || 'skipped'}`).join(', ');
  return `I did not inspect the local context. The proposed read-only action was not executed (${reasons}).`;
}


export { missingInspectionTargets, targetedUiInspectionMissingFallback };
