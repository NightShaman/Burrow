import { normalizeOutcomeCheck, verifyPublicReleaseOutcome } from './outcome-verification.mjs';

export const outcomeToolSchema = { type: 'function', function: {
  name: 'verify_outcome',
  description: 'Run an independent outcome check, not a report of agent or workflow completion. The Public release pilot checks the exact final GitHub release and immutable source tree, optionally the GHCR date-tag image ID. Supply the intended identity from the frozen publication inputs, never from the observed release. Reads public endpoints once, without polling, publishing, installing or credentials. Returns verified, mismatch, or unverified with expected/observed evidence; successful tool execution alone is not a verified outcome. The runtime records this check in the current run’s Proof.',
  parameters: { type: 'object', additionalProperties: false, properties: {
    verifier: { type: 'string', enum: ['github_public_release'] },
    repository: { type: 'string', description: 'Exact public GitHub owner/repository.' },
    version: { type: 'string', description: 'Intended plain UTC calendar release YYYY.MM.DD, including the original date when resuming.' },
    expectedArtifact: { type: 'object', additionalProperties: false, properties: {
      sourceTreeSha: { type: 'string', description: 'Git tree SHA of the frozen intended public source snapshot, not its development commit SHA.' },
      imageRepository: { type: 'string', description: 'Optional ghcr.io/owner/image; requires imageId.' },
      imageId: { type: 'string', description: 'Optional sha256 image config ID of the exact tested image; requires imageRepository. Not a registry manifest digest.' },
    }, required: ['sourceTreeSha'] },
    sourceRefs: { type: 'array', items: { type: 'string' }, description: 'Provenance for caller-supplied intent, for example the original frozen workflow artifact. These labels do not themselves attest CI.' },
    reason: { type: 'string' },
  }, required: ['verifier', 'repository', 'version', 'expectedArtifact'] },
} };

export async function executeOutcomeTool(args, options = {}) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || args.verifier !== 'github_public_release') {
    return { tool: 'verify_outcome', ok: false, error: 'outcome_verification_invalid_input' };
  }
  const { verifier: _verifier, reason: _reason, ...input } = args;
  try { return { tool: 'verify_outcome', ...await verifyPublicReleaseOutcome(input, options) }; }
  catch (error) {
    if (error?.code !== 'outcome_verification_invalid_input') throw error;
    return { tool: 'verify_outcome', ok: false, error: error.code, message: error.message };
  }
}

export function outcomeCheckSummary(check) {
  const outcome = check.status === 'verified' ? 'verified' : check.status === 'mismatch' ? 'mismatch' : 'unverified';
  return `Public release ${check.expected.repository} v${check.expected.version}: ${outcome} — ${check.reason}`;
}

// Only executed native results enter this boundary. Nested MCP output, assistant
// prose and caller-supplied verdicts are never promoted to an outcome receipt.
export function outcomeEvidenceForResult(result, sourceRefs = []) {
  if (result?.tool !== 'verify_outcome' || result.ok !== true) return null;
  const check = normalizeOutcomeCheck(result.outcomeCheck);
  if (!check) return null;
  const callId = result.toolCallId || result.execution?.toolCallId || result.activityId || null;
  return {
    text: outcomeCheckSummary(check),
    status: check.status === 'verified' ? 'validated' : check.status === 'mismatch' ? 'failed' : 'unknown',
    sourceRefs: [...new Set([...sourceRefs, ...(callId ? [`tool-call:${callId}`] : [])])],
    tool: 'verify_outcome', ...(callId ? { callId } : {}), outcomeCheck: check,
  };
}
