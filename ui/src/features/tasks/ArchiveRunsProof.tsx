import { useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import { api, type ArchiveRunDetail, type ArchiveRunListResponse, type ArchiveRunResponse } from '../../app/api';
import type { Agent } from '../../app/types';

function date(value?: string | null) {
  if (!value) return 'No date';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? 'No date' : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(parsed);
}
function duration(run: ArchiveRunDetail) {
  if (!run.startedAt || !run.completedAt) return '—';
  const ms = new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime();
  return Number.isFinite(ms) && ms >= 0 ? ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s` : '—';
}

type ArchiveRunStatusPresentation = { label: string; detail?: string };

const archiveRunStatus: Record<ArchiveRunDetail['status'], ArchiveRunStatusPresentation> = {
  completed: { label: 'Completed' },
  warning: { label: 'Warning' },
  failed: { label: 'Failed' },
  unverified: { label: 'Unverified', detail: 'A final answer was recorded, but no terminal receipt was captured. Treat this outcome as unverified.' },
  incomplete: { label: 'Incomplete', detail: 'Neither a final answer nor a terminal receipt was captured for this run.' },
};

function statusInfo(status: ArchiveRunDetail['status']) {
  return archiveRunStatus[status];
}
async function copyText(text: string) {
  try {
    if (navigator.clipboard?.writeText && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the synchronous browser fallback for local HTTP.
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  return copied;
}
function proofMarkdown(run: ArchiveRunDetail) {
  const evidence = (title: string, items: ArchiveRunDetail['evidence']['observations']) => items.length ? `### ${title}\n${items.map((item) => `- **${item.status}** ${item.text}`).join('\\n')}` : `### ${title}\n_No ${title.toLowerCase()} recorded._`;
  const timeline = run.timeline.length ? run.timeline.map((event) => `- **${event.kind.replace('_', ' ')}** (${date(event.ts)}) — ${event.summary}`).join('\\n') : '_No timeline evidence recorded._';
  const compression = run.context?.compression;
  return [
    `# ${run.objective || run.runId}`,
    `- Agent: ${run.agentName || run.agentId}`,
    `- Status: ${statusInfo(run.status).label}`,
    `- Started: ${date(run.startedAt)}`,
    `- Completed: ${date(run.completedAt)}`,
    `- Duration: ${duration(run)}`,
    `- Decision: ${run.decision || 'No terminal decision'}`,
    '',
    run.request ? `## Request\\n\\n${run.request}` : '',
    run.finalAnswer ? `## Final outcome\\n\\n${run.finalAnswer}` : '',
    '## Counts',
    `- Observations: ${run.counts.observations}`,
    `- Changes: ${run.counts.changes}`,
    `- Verifications: ${run.counts.verifications}`,
    `- Unresolved: ${run.counts.unresolved}`,
    `- Tool activity: ${run.counts.toolActivities}`,
    `- Subagents: ${run.counts.subagents}`,
    '', evidence('Actions / changes', run.evidence.changes), '', evidence('Verification', run.evidence.verifications), '', evidence('Unresolved', run.evidence.unresolved),
    '', '## Timeline', timeline,
    run.context ? `\\n## Context / compression proof\\n- Estimated tokens: ${String(run.context.budget?.estimatedTokens ?? '—')}\\n- Context window: ${String(run.context.budget?.contextWindow ?? '—')}\\n- Pressure: ${String(run.context.budget?.pressure ?? '—')}\\n- Attachments: ${run.context.attachments}\\n- Compression: ${compression?.label || 'Not recorded'}\\n- Turns summarized: ${compression?.summarizedTurnCount == null ? '—' : String(compression.summarizedTurnCount)}\\n\\n${compression?.detail || 'No compression decision was recorded for this older run.'}` : '',
  ].filter(Boolean).join('\\n');
}
function EvidenceList({ title, items }: { title: string; items: ArchiveRunDetail['evidence']['observations'] }) {
  return <section className="proof-section"><h3>{title}<span>{items.length}</span></h3>{items.length ? <ul>{items.map((item, index) => <li key={`${item.text}-${index}`}><strong className={`proof-status proof-status-${item.status}`}>{item.status}</strong><span>{item.text}</span></li>)}</ul> : <p className="proof-muted">No {title.toLowerCase()} recorded.</p>}</section>;
}
function ProofDetail({ run }: { run: ArchiveRunDetail }) {
  const compression = run.context?.compression;
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copy = async () => {
    const didCopy = await copyText(proofMarkdown(run));
    setCopyState(didCopy ? 'copied' : 'failed');
    window.setTimeout(() => setCopyState('idle'), 1500);
  };
  return <div className="archive-proof-detail">
    <header className="proof-detail-header"><div><span className="eyebrow">{run.agentName || run.agentId} · {statusInfo(run.status).label}</span><h2>{run.objective || run.runId}</h2><p>{date(run.startedAt)} → {date(run.completedAt)} · {duration(run)} · {run.decision || 'No terminal decision'}</p></div><div className="proof-detail-actions"><button type="button" className="archive-copy-button" onClick={copy} aria-label={copyState === 'copied' ? 'Proof copied' : 'Copy proof as Markdown'}><span aria-hidden="true">{copyState === 'copied' ? '✓' : '⧉'}</span>{copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy proof'}</button><span className={`proof-status-badge proof-status-${run.status}`}>{statusInfo(run.status).label}</span></div></header>
    {statusInfo(run.status).detail ? <section className="proof-status-notice" aria-label={`${statusInfo(run.status).label} run status`}><strong>{statusInfo(run.status).label}</strong><p>{statusInfo(run.status).detail}</p></section> : null}
    {run.request ? <section className="proof-final"><h3>Your request</h3><ReactMarkdown remarkPlugins={[remarkBreaks]}>{run.request}</ReactMarkdown></section> : null}
    {run.finalAnswer ? <section className="proof-final"><h3>Final outcome</h3><ReactMarkdown remarkPlugins={[remarkBreaks]}>{run.finalAnswer}</ReactMarkdown></section> : null}
    <div className="proof-counts">{Object.entries({ Observations: run.counts.observations, Changes: run.counts.changes, Verifications: run.counts.verifications, Unresolved: run.counts.unresolved, 'Tool activity': run.counts.toolActivities, Subagents: run.counts.subagents }).map(([label, count]) => <div key={label}><strong>{count}</strong><span>{label}</span></div>)}</div>
    <div className="proof-evidence-grid"><EvidenceList title="Actions / changes" items={run.evidence.changes} /><EvidenceList title="Verification" items={run.evidence.verifications} /><EvidenceList title="Unresolved" items={run.evidence.unresolved} /></div>
    <section className="proof-section"><h3>Timeline<span>{run.timeline.length}</span></h3>{run.timeline.length ? <ol className="proof-timeline">{run.timeline.map((event, index) => <li key={`${event.kind}-${event.ts}-${index}`}><span className={`proof-timeline-dot proof-status-${event.status}`} aria-hidden="true" /><div><strong>{event.kind.replace('_', ' ')}</strong><time>{date(event.ts)}</time><p>{event.summary}</p></div></li>)}</ol> : <p className="proof-muted">No timeline evidence recorded.</p>}</section>
    {run.context ? <section className="proof-section"><h3>Context / compression proof</h3><div className="proof-context-grid"><div><span>Estimated tokens</span><strong>{String(run.context.budget?.estimatedTokens ?? '—')}</strong></div><div><span>Context window</span><strong>{String(run.context.budget?.contextWindow ?? '—')}</strong></div><div><span>Pressure</span><strong>{String(run.context.budget?.pressure ?? '—')}</strong></div><div><span>Attachments</span><strong>{run.context.attachments}</strong></div><div><span>Compression</span><strong>{compression?.label || 'Not recorded'}</strong></div><div><span>Turns summarized</span><strong>{compression?.summarizedTurnCount == null ? '—' : String(compression.summarizedTurnCount)}</strong></div></div><p className="proof-muted">{compression?.detail || 'No compression decision was recorded for this older run.'}</p></section> : null}
    {run.subagents.length ? <section className="proof-section"><h3>Linked subagents<span>{run.subagents.length}</span></h3><div className="proof-subagents">{run.subagents.map((child) => { const verification = child.verification; const execution = child.status === 'succeeded' ? 'Child completed' : `Child ${child.status || 'status unknown'}`; return <article key={child.id}><strong>{child.label || child.purpose}</strong><span className={verification?.status === 'failed' ? 'proof-status-failed' : verification?.status === 'failed_expected' ? 'proof-status-warning' : ''}>{execution}{verification ? verification.expected ? ' · verification failed as expected' : ' · verification failed' : ''}</span>{verification ? <div className="proof-child-outcome"><b>{verification.expected ? 'No action required' : 'Action required'}</b>{verification.check ? <span>Check: {verification.check}</span> : null}<span>Observed: {verification.observed}</span></div> : child.result?.summary ? <p>{child.result.summary}</p> : null}<small>{child.result ? `${child.result.evidence || 0} findings · ${child.result.changedFiles || 0} changes` : 'No child result recorded'} · {child.trace?.runId ? `Trace ${String(child.trace.runId)}` : child.id}</small></article>; })}</div></section> : null}
  </div>;
}

export function ArchiveRunsProof({ agents, selectedAgent, search }: { agents: Agent[]; selectedAgent: string; search: string }) {
  const [runs, setRuns] = useState<ArchiveRunDetail[]>([]);
  const [selected, setSelected] = useState<ArchiveRunDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState('');
  const [detailError, setDetailError] = useState('');
  useEffect(() => {
    const abort = new AbortController(); setLoading(true); setError(''); setSelected(null);
    const query = new URLSearchParams({ limit: '100' }); if (selectedAgent) query.set('agentId', selectedAgent);
    api<ArchiveRunListResponse>(`/api/archive/runs?${query}`, { signal: abort.signal }).then((response) => { if (!abort.signal.aborted) setRuns(response.runs); }).catch((cause) => { if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not load archive runs.'); }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [selectedAgent]);
  const visible = useMemo(() => { const query = search.trim().toLowerCase(); return runs.filter((run) => !query || `${run.agentName || run.agentId} ${run.objective || ''} ${run.finalAnswer || ''} ${run.status}`.toLowerCase().includes(query)); }, [runs, search]);
  const open = (run: ArchiveRunDetail) => { setSelected(run); setDetailError(''); setDetailLoading(true); const query = `?agentId=${encodeURIComponent(run.agentId)}`; api<ArchiveRunResponse>(`/api/archive/runs/${encodeURIComponent(run.runId)}${query}`).then((response) => setSelected(response.run)).catch((cause) => setDetailError(cause instanceof Error ? cause.message : 'Could not open this run.')).finally(() => setDetailLoading(false)); };
  return <div className="archive-split-view archive-proof-view"><section className="archive-results-pane" aria-label="Archive proof runs"><div className="archive-pane-heading"><span className="eyebrow">Runs</span><strong>{visible.length} runs</strong></div><div className="archive-session-list">{loading ? <section className="archive-empty-state"><div className="archive-empty-mark">⌁</div><div><h3>Gathering proof.</h3><p>Loading archived run outcomes.</p></div></section> : null}{error ? <section className="archive-empty-state archive-error"><div className="archive-empty-mark">!</div><div><h3>Could not load archive runs.</h3><p>{error}</p></div></section> : null}{!loading && !error && !visible.length ? <section className="archive-empty-state"><div className="archive-empty-mark">⌁</div><div><h3>No proof runs found.</h3><p>Try another agent or search.</p></div></section> : null}{!loading && !error ? visible.map((run) => <button type="button" className={`archive-session-card proof-run-card${selected?.runId === run.runId ? ' selected' : ''}`} key={run.runId} onClick={() => open(run)}><div className="archive-session-main"><div className="archive-session-meta"><span>{run.agentName || run.agentId}</span><span>{date(run.completedAt || run.startedAt)}</span></div><h3>{run.objective || run.runId}</h3><p>{statusInfo(run.status).label} · {duration(run)} · {run.counts.toolActivities} tool activities · {run.counts.unresolved} unresolved</p></div><div className="archive-session-side"><strong className={`proof-status-text proof-status-${run.status}`}>{statusInfo(run.status).label}</strong><span>{run.counts.observations + run.counts.changes + run.counts.verifications} evidence</span></div></button>) : null}</div></section><section className="archive-reader-pane">{selected ? <div className="archive-content-body archive-reader-body">{detailLoading ? <section className="archive-empty-state"><div className="archive-empty-mark">⌁</div><div><h3>Opening proof.</h3><p>Reading the run evidence.</p></div></section> : detailError ? <section className="archive-empty-state archive-error"><div className="archive-empty-mark">!</div><div><h3>Could not open this run.</h3><p>{detailError}</p></div></section> : <ProofDetail run={selected} />}</div> : <section className="archive-empty-state archive-reader-placeholder"><div className="archive-empty-mark">⌁</div><div><h3>Select a proof run.</h3><p>Choose a run to inspect its outcome, evidence, context, and linked subagents.</p></div></section>}</section></div>;
}
