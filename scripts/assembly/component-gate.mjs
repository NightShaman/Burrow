import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
export function classifyRuns(runs, { sha, workflowId }) {
  const matching = runs.filter(r => r.workflow_id === workflowId && r.head_sha === sha && r.head_branch === 'main' && r.event === 'push');
  // A newer retry supersedes older evidence; never accept an old green retry
  // while the latest trusted attempt is pending or failed.
  matching.sort((a,b) => b.run_number - a.run_number || b.run_attempt - a.run_attempt);
  const latest = matching[0];
  if (!latest) return 'missing';
  if (latest.status !== 'completed') return 'pending';
  return latest.conclusion === 'success' ? 'accepted' : 'rejected';
}
export async function waitForComponent({ repo, sha, api, timeoutMs = 3600000, sleep = ms => new Promise(r => setTimeout(r,ms)), now = Date.now }) {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw Error('immutable SHA required');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw Error('invalid gate timeout');
  const workflow = await api(`repos/${repo}/actions/workflows/notify-burrow.yml`);
  if (workflow.name !== 'Verify and assemble Burrow' || workflow.path !== '.github/workflows/notify-burrow.yml' || workflow.state !== 'active') throw Error('untrusted component workflow');
  const deadline = now() + timeoutMs;
  while (true) {
    const runs = await api(`repos/${repo}/actions/workflows/${workflow.id}/runs?head_sha=${sha}&branch=main&event=push&per_page=100`, true);
    const state = classifyRuns(runs, {sha, workflowId:workflow.id});
    if (state === 'accepted') return;
    if (state !== 'pending') throw Error(`${repo}@${sha}: component CI ${state}`);
    if (now() >= deadline) throw Error(`${repo}@${sha}: component CI timeout`);
    await sleep(Math.min(15000, deadline-now()));
  }
}
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const api = async (endpoint, paginate=false) => {
    const args=['api',endpoint]; if(paginate) args.push('--paginate','--slurp');
    const value=JSON.parse(execFileSync('gh',args,{encoding:'utf8'}));
    return paginate ? value.flatMap(page=>page.workflow_runs) : value;
  };
  await waitForComponent({repo:process.argv[2],sha:process.argv[3],api,timeoutMs:Number(process.env.COMPONENT_CI_TIMEOUT_MS || 3600000)});
}
