import { normalizeWaitTarget } from './task-workflow-wait.mjs';

const maxResponseBytes = 1024 * 1024;

export function sameWorkflowTarget(expected, actual) {
  return actual && expected.repository === actual.repository && expected.workflow === actual.workflow &&
    expected.runId === actual.runId && expected.runAttempt === actual.runAttempt && expected.headSha === actual.headSha;
}

async function readResponse(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let data = '', size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return JSON.parse(data + decoder.decode());
      size += value.byteLength;
      if (size > maxResponseBytes) {
        void reader.cancel().catch(() => {});
        throw new Error('github_workflow_attempt_response_too_large');
      }
      data += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

export async function readGitHubWorkflowAttempt(input, { fetchAttempt = fetch, signal, apiToken = process.env.BURROW_GITHUB_ACTIONS_READ_TOKEN } = {}) {
  const target = normalizeWaitTarget(input);
  const unavailable = diagnostic => ({ diagnostic });
  const [owner, repo] = target.repository.split('/');
  // URL parsers normalize dot segments even when the dots are percent-encoded.
  if ([owner, repo].some(segment => segment === '.' || segment === '..')) return unavailable('github_api_identity_mismatch');
  const runPath = `/${owner}/${repo}/actions/runs/${target.runId}`;
  const timeout = AbortSignal.timeout(4000);
  try {
    const response = await fetchAttempt(`https://api.github.com/repos${runPath}/attempts/${target.runAttempt}`, {
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: { accept: 'application/vnd.github+json', ...(apiToken ? { authorization: `Bearer ${apiToken}` } : {}) },
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      return unavailable(`github_api_http_${response.status}`);
    }
    const run = await readResponse(response);
    const repository = run?.repository?.full_name;
    const headSha = run?.head_sha;
    if (!Number.isSafeInteger(run?.id) || !Number.isSafeInteger(run.run_attempt) ||
        typeof repository !== 'string' || typeof run.name !== 'string' || typeof headSha !== 'string') {
      return unavailable('github_api_invalid_identity');
    }
    if (!sameWorkflowTarget(target, {
      repository: repository.toLowerCase(), workflow: run.name,
      runId: String(run.id), runAttempt: run.run_attempt, headSha: headSha.toLowerCase(),
    })) return unavailable('github_api_identity_mismatch');
    if (run.status !== 'completed') return typeof run.status === 'string' && run.status
      ? { diagnostic: null } : unavailable('github_api_invalid_status');
    const completedAt = typeof run.updated_at === 'string' ? Date.parse(run.updated_at) : NaN;
    if (typeof run.conclusion !== 'string' || !/^[a-z_]{1,128}$/.test(run.conclusion) || !Number.isFinite(completedAt)) {
      return unavailable('github_api_invalid_completion');
    }
    return { completion: { ...target, conclusion: run.conclusion, completedAt: new Date(completedAt).toISOString(),
      url: `https://github.com${runPath}`, provenance: 'github_api' } };
  } catch {
    return unavailable(timeout.aborted ? 'github_api_timeout' : 'github_api_unavailable');
  }
}
