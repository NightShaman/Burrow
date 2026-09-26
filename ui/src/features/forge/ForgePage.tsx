import { useEffect, useMemo, useRef, useState } from 'react';
import { api, fetchApi } from '../../app/api';
import type { Agent } from '../../app/types';
import './forge.css';

type ForgeModel = { connectionId: string; modelId: string; label: string; kind: 'image' | 'audio' | 'video'; available: boolean; unavailableReason?: string | null; controls: string[] };
type ForgeCatalog = { models: ForgeModel[]; sourceAttachments?: { available: boolean; reason?: string | null }; video?: { available: boolean; reason?: string | null } };
type Artifact = { id: string; kind: string; name: string; mimeType: string; sizeBytes: number; previewUrl?: string | null; downloadUrl?: string | null };
type Job = { id: string; agentId: string; connectionId: string; modelId: string; kind: 'image' | 'audio' | 'video'; prompt: string; status: 'queued' | 'running' | 'succeeded' | 'failed' | 'interrupted'; createdAt: string; updatedAt: string; error?: string | null; artifacts: Artifact[] };

const modeLabels = { image: 'Image', video: 'Video', audio: 'Speech' } as const;
const newKey = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;

function artifactPath(url: string): string {
  try {
    const parsed = new URL(url, window.location.origin);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

function ArtifactDownload({ artifact }: { artifact: Artifact }) {
  const [href, setHref] = useState('');
  useEffect(() => {
    let cancelled = false;
    let objectUrl = '';
    if (!artifact.downloadUrl) return undefined;
    void fetchApi(artifactPath(artifact.downloadUrl), { headers: { accept: 'application/octet-stream, */*' } })
      .then((response) => { if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.blob(); })
      .then((blob) => { if (!cancelled) { objectUrl = URL.createObjectURL(blob); setHref(objectUrl); } })
      .catch(() => { if (!cancelled) setHref(''); });
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [artifact.downloadUrl]);
  return href ? <a href={href} download={artifact.name}>Download</a> : <span className="forge-download-pending">Preparing download…</span>;
}

function ArtifactMedia({ artifact }: { artifact: Artifact }) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    let cancelled = false;
    let objectUrl = '';
    const source = artifact.previewUrl;
    if (!source) return undefined;
    void fetchApi(artifactPath(source), { headers: { accept: artifact.mimeType || '*/*' } })
      .then((response) => { if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.blob(); })
      .then((blob) => { if (!cancelled) { objectUrl = URL.createObjectURL(blob); setSrc(objectUrl); } })
      .catch(() => { if (!cancelled) setSrc(''); });
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [artifact.previewUrl, artifact.mimeType]);
  if (!src) return <div className="forge-file">Loading preview…</div>;
  if (artifact.kind === 'image') return <img src={src} alt={artifact.name} />;
  if (artifact.kind === 'video') return <video controls src={src} />;
  if (artifact.kind === 'audio') return <audio controls src={src} />;
  return <div className="forge-file">{artifact.name}</div>;
}

export function Forge({ agents, selectedAgentId, sessionId }: { agents: Agent[]; selectedAgentId: string; sessionId: string }) {
  const [mode, setMode] = useState<'image' | 'video' | 'audio'>('image');
  const [models, setModels] = useState<ForgeModel[]>([]);
  const [catalog, setCatalog] = useState<ForgeCatalog | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [selectedModel, setSelectedModel] = useState('');
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [selectedJobId, setSelectedJobId] = useState('');
  const loadSequence = useRef(0);
  const activeAgentRef = useRef(selectedAgentId);
  const idempotencyRef = useRef<{ signature: string; key: string } | null>(null);

  useEffect(() => {
    activeAgentRef.current = selectedAgentId;
    idempotencyRef.current = null;
    setSelectedJobId('');
    setJobs([]);
    setCatalog(null);
    setModels([]);
  }, [selectedAgentId]);

  const load = async () => {
    if (!selectedAgentId) return;
    const sequence = ++loadSequence.current;
    setLoading(true); setError('');
    try {
      const [catalog, history] = await Promise.all([
        api<ForgeCatalog>('/api/forge/catalog'),
        api<{ jobs: Job[] }>(`/api/forge/jobs?agentId=${encodeURIComponent(selectedAgentId)}`),
      ]);
      if (sequence !== loadSequence.current || activeAgentRef.current !== selectedAgentId) return;
      setCatalog(catalog); setModels(catalog.models ?? []); setJobs(history.jobs ?? []);
    } catch (e) {
      if (sequence === loadSequence.current && activeAgentRef.current === selectedAgentId) setError(`Could not load Forge: ${(e as Error).message}`);
    } finally {
      if (sequence === loadSequence.current && activeAgentRef.current === selectedAgentId) setLoading(false);
    }
  };
  useEffect(() => { void load(); }, [selectedAgentId]);
  const modeModels = useMemo(() => models.filter((m) => m.kind === mode), [models, mode]);
  const availableModels = useMemo(() => modeModels.filter((m) => m.available), [modeModels]);
  const unavailableModels = useMemo(() => modeModels.filter((m) => !m.available), [modeModels]);
  const modeUnavailableReason = mode === 'video' ? catalog?.video?.reason : unavailableModels[0]?.unavailableReason;
  useEffect(() => { if (!availableModels.some((m) => `${m.connectionId}:${m.modelId}` === selectedModel)) setSelectedModel(availableModels[0] ? `${availableModels[0].connectionId}:${availableModels[0].modelId}` : ''); }, [availableModels, selectedModel]);
  useEffect(() => {
    const active = jobs.some((job) => job.status === 'queued' || job.status === 'running');
    if (!active || !selectedAgentId) return;
    let cancelled = false;
    const agentAtStart = selectedAgentId;
    const timer = window.setInterval(() => {
      void api<{ jobs: Job[] }>(`/api/forge/jobs?agentId=${encodeURIComponent(agentAtStart)}`)
        .then((result) => {
          if (!cancelled && activeAgentRef.current === agentAtStart) setJobs(result.jobs ?? []);
        })
        .catch(() => {});
    }, 1500);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [jobs, selectedAgentId]);
  const selectedJob = jobs.find((job) => job.id === selectedJobId) ?? jobs[0];
  const submit = async () => {
    const agentAtStart = selectedAgentId;
    const model = availableModels.find((item) => `${item.connectionId}:${item.modelId}` === selectedModel);
    if (!model || !prompt.trim() || !agentAtStart) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const requestSignature = `${selectedAgentId}\u0000${model.connectionId}\u0000${model.modelId}\u0000${prompt.trim()}`;
      const existing = idempotencyRef.current;
      const idempotencyKey = existing?.signature === requestSignature ? existing.key : newKey();
      idempotencyRef.current = { signature: requestSignature, key: idempotencyKey };
      const result = await api<{ job: Job }>('/api/forge/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentId: agentAtStart, connectionId: model.connectionId, modelId: model.modelId, prompt: prompt.trim(), idempotencyKey }) });
      if (activeAgentRef.current !== agentAtStart) return;
      setJobs((current) => [result.job, ...current.filter((job) => job.id !== result.job.id)]); setSelectedJobId(result.job.id); setPrompt(''); setNotice('Forge job accepted.');
      idempotencyRef.current = null;
    } catch (e) { if (activeAgentRef.current === agentAtStart) setError(`Could not start generation: ${(e as Error).message}`); } finally { if (activeAgentRef.current === agentAtStart) setBusy(false); }
  };
  const attach = async (artifact: Artifact) => {
    const agentAtStart = selectedAgentId;
    if (!selectedJob || !sessionId || !agentAtStart) return;
    try { await api(`/api/forge/jobs/${encodeURIComponent(selectedJob.id)}/attach`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentId: agentAtStart, sessionId, artifactId: artifact.id }) }); if (activeAgentRef.current === agentAtStart) setNotice('Attached to the current conversation.'); } catch (e) { if (activeAgentRef.current === agentAtStart) setError(`Could not attach artifact: ${(e as Error).message}`); }
  };
  return <main className="forge-page">
    <header className="forge-heading"><div><span className="eyebrow">FORGE</span><h1>The Phantasm Forge</h1><p>Manufacture sights, sounds, and moving lies.</p></div><div className="forge-agent"><span>Working as</span><strong>{agents.find((agent) => agent.id === selectedAgentId)?.name ?? 'No agent selected'}</strong></div></header>
    <div className="forge-modes" role="tablist" aria-label="Forge modes">{(['image', 'video', 'audio'] as const).map((item) => <button key={item} role="tab" aria-selected={mode === item} className={mode === item ? 'active' : ''} onClick={() => setMode(item)}>{item === 'image' ? '▧' : item === 'video' ? '◉' : '◌'}<span>{modeLabels[item]}</span></button>)}</div>
    <div className="forge-grid"><section className="forge-studio"><div className="forge-panel-head"><div><span className="eyebrow">CREATE</span><h2>{modeLabels[mode]} generation</h2></div><span className="forge-badge">{availableModels.length} model{availableModels.length === 1 ? '' : 's'}</span></div><label className="forge-field"><span>Model</span><select aria-label="Forge model" value={selectedModel} onChange={(event) => setSelectedModel(event.target.value)} disabled={!availableModels.length}>{availableModels.map((model) => <option key={`${model.connectionId}:${model.modelId}`} value={`${model.connectionId}:${model.modelId}`}>{model.label}</option>)}</select></label><label className="forge-field forge-prompt"><span>Prompt</span><textarea aria-label={mode === 'audio' ? 'Script' : 'Prompt'} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder={mode === 'audio' ? 'Enter the words to speak…' : `Describe the ${mode} to manufacture…`} /><small>{mode === 'audio' ? 'Verbatim script' : 'Prompt'}</small></label><div className="forge-actions"><button className="forge-primary" type="button" onClick={() => void submit()} disabled={busy || !selectedModel || !prompt.trim()}>{busy ? 'Starting…' : `Generate ${modeLabels[mode]}`}</button>{notice && <span className="forge-notice" role="status">{notice}</span>}</div>{error && <p className="forge-error" role="alert">{error}</p>}{!loading && !availableModels.length && <div className="forge-empty"><strong>{mode === 'video' ? 'Video generation is unavailable' : `No ${modeLabels[mode].toLowerCase()} models available`}</strong><span>{modeUnavailableReason ?? (mode === 'video' ? 'This release does not have a video provider contract.' : 'Configure a compatible model connection to use this mode.')}</span></div>}
      {mode === 'video' && catalog?.sourceAttachments && <p className="forge-capability-note">Source attachments: unavailable — {catalog.sourceAttachments.reason ?? 'not supported by this release.'}</p>}</section><section className="forge-preview"><div className="forge-panel-head"><div><span className="eyebrow">OUTPUT</span><h2>{selectedJob ? modeLabels[selectedJob.kind] : 'Preview'}</h2></div>{selectedJob && <span className={`forge-status ${selectedJob.status}`}>{selectedJob.status}</span>}</div>{selectedJob?.artifacts?.length ? <div className="forge-artifacts">{selectedJob.artifacts.map((artifact) => <article className="forge-artifact" key={artifact.id}>{artifact.previewUrl ? <ArtifactMedia artifact={artifact} /> : <div className="forge-file">{artifact.name}</div>}<footer><strong>{artifact.name}</strong><div>{artifact.downloadUrl && <ArtifactDownload artifact={artifact} />}<button type="button" onClick={() => void attach(artifact)} disabled={!sessionId}>Attach to conversation</button></div></footer></article>)}</div> : <div className="forge-placeholder"><span aria-hidden="true">✦</span><strong>{selectedJob ? selectedJob.status === 'failed' ? 'Generation failed' : selectedJob.status === 'interrupted' ? 'Generation interrupted' : 'Preparing your artifact…' : 'Your creation will appear here'}</strong><small>{selectedJob?.error ?? 'Forge uses the full workspace for the work, and keeps the result close at hand.'}</small></div>}</section></div>
    <section className="forge-history"><div className="forge-panel-head"><div><span className="eyebrow">HISTORY</span><h2>Recent creations</h2></div><button type="button" onClick={() => void load()}>Refresh</button></div>{jobs.length ? <div className="forge-jobs">{jobs.map((job) => <button type="button" key={job.id} className={selectedJob?.id === job.id ? 'selected' : ''} onClick={() => setSelectedJobId(job.id)}><span className={`forge-status ${job.status}`}>{job.status}</span><strong>{modeLabels[job.kind]}</strong><span>{job.prompt}</span><time>{new Date(job.createdAt).toLocaleString()}</time></button>)}</div> : <p className="forge-muted">No creations yet.</p>}</section>
  </main>;
}
