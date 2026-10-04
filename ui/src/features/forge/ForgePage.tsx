import { rovingKeys } from '../../app/keyboardWidgets';
import { useOwnedApi } from '../../app/useOwnedApi';
import { ImagePreview } from '../../app/ImagePreview';
import { useEffect, useMemo, useRef, useState } from 'react';

import type { Agent } from '../../app/types';
import './forge.css';

type ForgeModel = { connectionId: string; modelId: string; label: string; kind: 'image' | 'audio' | 'video'; available: boolean; unavailableReason?: string | null; controls: string[] };
type ForgeCatalog = { models: ForgeModel[]; music?: { available: boolean; reason?: string | null; models?: ForgeModel[] }; sourceAttachments?: { available: boolean; reason?: string | null }; video?: { available: boolean; reason?: string | null } };
type Artifact = { id: string; kind: string; name: string; mimeType: string; sizeBytes: number; previewUrl?: string | null; downloadUrl?: string | null };
type ForgeErrorDetails = { stage: string; message: string; code?: string; httpStatus?: number; requestId?: string; truncated?: boolean; observedBytes?: number; maxBytes?: number };
type Job = { id: string; connectionId: string; modelId: string; kind: 'image' | 'audio' | 'video' | 'music'; mode?: 'image' | 'music' | 'speech' | 'video' | null; prompt: string; status: 'queued' | 'running' | 'succeeded' | 'failed' | 'interrupted'; createdAt: string; updatedAt: string; error?: string | null; errorDetails?: ForgeErrorDetails | null; artifacts: Artifact[] };

function safeDiagnosticText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/(bearer\s+)[^\s,;]+/gi, '$1[redacted]')
    .replace(/((?:api[_-]?key|token|secret|password)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]');
}

function FailureDetails({ job }: { job: Job }) {
  const details = job.errorDetails;
  if (!details) return <small>{job.error || 'Generation failed. No further details are available.'}</small>;
  const stage = safeDiagnosticText(details.stage);
  const message = safeDiagnosticText(details.message) || safeDiagnosticText(job.error) || 'Generation failed.';
  const code = safeDiagnosticText(details.code);
  const requestId = safeDiagnosticText(details.requestId);
  const httpStatus = Number.isInteger(details.httpStatus) && details.httpStatus! > 0 ? details.httpStatus : undefined;
  return <div className="forge-failure-details" aria-label="Failure details">
    <p>{message}</p>
    <dl>
      {stage && <><dt>Stage</dt><dd>{stage}</dd></>}
      {code && <><dt>Code</dt><dd>{code}</dd></>}
      {httpStatus && <><dt>HTTP</dt><dd>{httpStatus}</dd></>}
      {requestId && <><dt>Request ID</dt><dd>{requestId}</dd></>}
    </dl>
    {details.truncated === true && <p className="forge-diagnostic-truncated">Provider error response truncated at ingestion{Number.isFinite(details.maxBytes) ? ` (budget: ${details.maxBytes} bytes` : ''}{Number.isFinite(details.observedBytes) ? `${Number.isFinite(details.maxBytes) ? '; ' : ' ('}at least ${details.observedBytes} bytes read` : ''}{Number.isFinite(details.maxBytes) || Number.isFinite(details.observedBytes) ? ')' : ''}.</p>}
  </div>;
}

const modeLabels = { image: 'Image', video: 'Video', audio: 'Speech', music: 'Music' } as const;
function jobMode(job: Job): 'image' | 'video' | 'audio' | 'music' | null {
  if (job.mode === 'speech') return 'audio';
  if (job.mode === 'image' || job.mode === 'video' || job.mode === 'music') return job.mode;
  return job.kind === 'audio' ? null : job.kind;
}
function jobLabel(job: Job): string {
  const mode = jobMode(job);
  return mode ? modeLabels[mode] : 'Audio';
}
type SelectionMode = 'image' | 'video' | 'speech' | 'music';
type ModelSelection = { connectionId: string; modelId: string };
type Selections = Partial<Record<SelectionMode, ModelSelection>>;
const modelKey = (model: ModelSelection) => JSON.stringify([model.connectionId, model.modelId]);
const newKey = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;

export function composeMusicPrompt(direction: string, lyrics: string): string {
  const base = direction.trim();
  const suppliedLyrics = lyrics.trim();
  if (!suppliedLyrics) return base;
  return `${base}\n\nWith the following lyrics:\n${suppliedLyrics}`;
}

function artifactPath(url: string): string {
  try {
    const parsed = new URL(url, window.location.origin);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

export function ArtifactOutput({ artifact, fetchMedia }: { artifact: Artifact; fetchMedia: ReturnType<typeof useOwnedApi>["fetch"] }) {
  const [src, setSrc] = useState('');
  const [previewState, setPreviewState] = useState('loading');
  const [downloadState, setDownloadState] = useState('idle');
  const [attempt, setAttempt] = useState(0);
  const resource = useMemo(() => ({ active: true, abort: new AbortController(), urls: new Set<string>(), requests: new Map<string, Promise<string>>() }), [artifact.id, artifact.previewUrl, artifact.downloadUrl, artifact.mimeType, fetchMedia]);
  const load = (source: string) => {
    const path = artifactPath(source);
    const cached = resource.requests.get(path);
    if (cached) return cached;
    const signal = resource.abort.signal;
    const request = fetchMedia(path, { signal, headers: { accept: artifact.mimeType || '*/*' } })
      .then(response => { if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.blob(); })
      .then(blob => {
        if (!resource.active || signal.aborted) throw new Error('Artifact retired');
        const url = URL.createObjectURL(blob);
        resource.urls.add(url);
        return url;
      }).catch(error => { if (resource.requests.get(path) === request) resource.requests.delete(path); throw error; });
    resource.requests.set(path, request);
    return request;
  };
  useEffect(() => {
    resource.active = true;
    if (resource.abort.signal.aborted) resource.abort = new AbortController();
    return () => {
      resource.active = false;
      resource.abort.abort();
      resource.urls.forEach(url => URL.revokeObjectURL(url));
      resource.urls.clear();
      resource.requests.clear();
    };
  }, [resource]);
  useEffect(() => {
    let cancelled = false;
    setSrc(''); setPreviewState('loading'); setDownloadState('idle');
    if (artifact.previewUrl) void load(artifact.previewUrl).then(url => {
      if (!cancelled) { setSrc(url); setPreviewState('ready'); }
    }).catch(() => { if (!cancelled) setPreviewState('failed'); });
    return () => { cancelled = true; };
  }, [resource, attempt]);
  const download = async () => {
    if (!artifact.downloadUrl || downloadState === 'loading') return;
    setDownloadState('loading');
    try {
      const url = await load(artifact.downloadUrl);
      if (!resource.active) return;
      const link = document.createElement('a');
      link.href = url; link.download = artifact.name;
      document.body.appendChild(link); link.click(); link.remove();
      setDownloadState('idle');
    } catch { if (resource.active) setDownloadState('failed'); }
  };
  return <>
    {!artifact.previewUrl ? <div className="forge-file">{artifact.name}</div> : previewState === 'failed' ? <div className="forge-file"><p role="alert">Preview failed.</p><button type="button" onClick={() => setAttempt(value => value + 1)}>Retry preview</button></div> : !src ? <div className="forge-file">Loading preview…</div> : artifact.kind === 'image' ? <ImagePreview src={src} alt={artifact.name} /> : artifact.kind === 'video' ? <video controls src={src} /> : artifact.kind === 'audio' ? <audio controls src={src} /> : <div className="forge-file">{artifact.name}</div>}
    {artifact.downloadUrl && <div>{downloadState === 'failed' && <p role="alert">Download failed.</p>}<button type="button" disabled={downloadState === 'loading'} onClick={() => void download()}>{downloadState === 'loading' ? 'Preparing download…' : downloadState === 'failed' ? 'Retry download' : 'Download'}</button></div>}
  </>;
}

export function Forge({ selectedAgentId, sessionId }: { agents?: Agent[]; selectedAgentId: string; sessionId: string }) {
  const owned = useOwnedApi();
  const api = owned.api;
  const [mode, setMode] = useState<'image' | 'video' | 'audio' | 'music'>('image');
  const [showRecents, setShowRecents] = useState(false);
  const [models, setModels] = useState<ForgeModel[]>([]);
  const [catalog, setCatalog] = useState<ForgeCatalog | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [selections, setSelections] = useState<Selections>({});
  const [selectionSaving, setSelectionSaving] = useState(false);
  const selectionSavingRef = useRef(false);
  const [selectionError, setSelectionError] = useState('');
  const [prompt, setPrompt] = useState('');
  const [lyrics, setLyrics] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [selectedJobId, setSelectedJobId] = useState('');
  const loadSequence = useRef(0);
  const activeAgentRef = useRef(selectedAgentId);
  const idempotencyRef = useRef<{ signature: string; key: string } | null>(null);

  useEffect(() => { activeAgentRef.current = selectedAgentId; }, [selectedAgentId]);

  const load = async () => {
    const sequence = ++loadSequence.current;
    setLoading(true); setError('');
    try {
      const [catalog, history, saved] = await Promise.all([
        api<ForgeCatalog>('/api/forge/catalog'),
        api<{ jobs: Job[] }>('/api/forge/jobs'),
        api<{ selections: Selections }>('/api/forge/selections'),
      ]);
      if (sequence !== loadSequence.current) return;
      setSelections(saved.selections ?? {});
      setCatalog(catalog); setModels(catalog.models ?? []); setJobs(history.jobs ?? []);
    } catch (e) {
      if (sequence === loadSequence.current) setError(`Could not load Forge: ${(e as Error).message}`);
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  };
  useEffect(() => { void load(); return () => { ++loadSequence.current; }; }, []);
  const modeModels = useMemo(() => {
    if (mode === 'music') return catalog?.music?.models ?? [];
    if (mode === 'audio') {
      const musicKeys = new Set((catalog?.music?.models ?? []).map((m) => `${m.connectionId}:${m.modelId}`));
      return models.filter((m) => m.kind === 'audio' && !musicKeys.has(`${m.connectionId}:${m.modelId}`));
    }
    return models.filter((m) => m.kind === mode);
  }, [catalog, models, mode]);
  const availableModels = useMemo(() => modeModels.filter((m) => m.available), [modeModels]);
  const unavailableModels = useMemo(() => modeModels.filter((m) => !m.available), [modeModels]);
  const modeUnavailableReason = mode === 'video' ? catalog?.video?.reason : mode === 'music' ? catalog?.music?.reason : unavailableModels[0]?.unavailableReason;
  const selectionMode: SelectionMode = mode === 'audio' ? 'speech' : mode;
  const savedSelection = selections[selectionMode];
  const selectedModel = savedSelection ? modelKey(savedSelection) : availableModels[0] ? modelKey(availableModels[0]) : '';
  const selectedAvailable = availableModels.some((model) => modelKey(model) === selectedModel);
  const savedUnavailableReason = savedSelection && !selectedAvailable
    ? modeModels.find((model) => modelKey(model) === selectedModel)?.unavailableReason ?? 'This saved model is no longer in the catalog. Choose another model.'
    : '';
  const saveSelection = async (key: string) => {
    if (loading || selectionSavingRef.current) return;
    const model = availableModels.find((item) => modelKey(item) === key);
    if (!model) return;
    selectionSavingRef.current = true;
    setSelectionSaving(true); setSelectionError('');
    const sequence = loadSequence.current;
    try {
      const result = await api<{ selections: Selections }>('/api/forge/selections', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: selectionMode, connectionId: model.connectionId, modelId: model.modelId }),
      });
      if (sequence === loadSequence.current) setSelections(result.selections);
    } catch (e) {
      if (sequence === loadSequence.current) setSelectionError(`Could not save model selection: ${(e as Error).message}. Your previous selection is unchanged; choose again to retry.`);
    } finally {
      selectionSavingRef.current = false;
      if (sequence === loadSequence.current) setSelectionSaving(false);
    }
  };
  useEffect(() => {
    const active = jobs.some((job) => job.status === 'queued' || job.status === 'running');
    if (!active) return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      void api<{ jobs: Job[] }>('/api/forge/jobs')
        .then((result) => {
          if (!cancelled) setJobs(result.jobs ?? []);
        })
        .catch(() => {});
    }, 1500);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [jobs]);
  const scopedJobs = showRecents ? jobs : jobs.filter((job) => jobMode(job) === mode);
  const recentJobs = showRecents ? scopedJobs : scopedJobs.slice(0, 5);
  const selectedJob = scopedJobs.find((job) => job.id === selectedJobId) ?? scopedJobs[0];
  const submit = async () => {
    const model = availableModels.find((item) => modelKey(item) === selectedModel);
    const submittedPrompt = mode === 'music' ? composeMusicPrompt(prompt, lyrics) : prompt.trim();
    if (loading || selectionSavingRef.current || !model || !submittedPrompt) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const requestSignature = `${model.connectionId}\u0000${model.modelId}\u0000${submittedPrompt}`;
      const existing = idempotencyRef.current;
      const idempotencyKey = existing?.signature === requestSignature ? existing.key : newKey();
      idempotencyRef.current = { signature: requestSignature, key: idempotencyKey };
      const result = await api<{ job: Job }>('/api/forge/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ connectionId: model.connectionId, modelId: model.modelId, prompt: submittedPrompt, idempotencyKey }) });
      setJobs((current) => [result.job, ...current.filter((job) => job.id !== result.job.id)]); setSelectedJobId(result.job.id); setPrompt(''); setLyrics(''); setNotice('Forge job accepted.');
      idempotencyRef.current = null;
    } catch (e) { setError(`Could not start generation: ${(e as Error).message}`); } finally { setBusy(false); }
  };
  const attach = async (artifact: Artifact) => {
    const agentAtStart = selectedAgentId;
    if (!selectedJob || !sessionId || !agentAtStart) return;
    try { const resourceAgentId = agentAtStart; await api(`/api/forge/jobs/${encodeURIComponent(selectedJob.id)}/attach`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentId: resourceAgentId, sessionId, artifactId: artifact.id }) }); if (activeAgentRef.current === agentAtStart) setNotice('Attached to the current conversation.'); } catch (e) { if (activeAgentRef.current === agentAtStart) setError(`Could not attach artifact: ${(e as Error).message}`); }
  };
  return <main className="forge-page">
    <header className="forge-heading"><div><h1>The Phantasm Forge</h1><p>Manufacture sights, sounds, and moving lies.</p></div>
    <div className="forge-modes" role="tablist" aria-label="Forge modes" onKeyDown={event => rovingKeys(event, '[role="tab"]')}>{(['image', 'video', 'audio', 'music'] as const).map((item) => <button key={item} role="tab" tabIndex={!showRecents && mode === item ? 0 : -1} aria-selected={!showRecents && mode === item} className={!showRecents && mode === item ? 'active' : ''} onClick={() => { setMode(item); setShowRecents(false); }}>{item === 'image' ? '▧' : item === 'video' ? '◉' : item === 'audio' ? '◌' : '♫'}<span>{modeLabels[item]}</span></button>)}<button role="tab" aria-selected={showRecents} className={showRecents ? 'active' : ''} onClick={() => setShowRecents(true)}>◷<span>Recents</span></button></div></header>
    <div className={`forge-grid${showRecents ? ' forge-recents-grid' : ''}`}><section className="forge-studio" hidden={showRecents}><div className="forge-panel-head"><div><span className="eyebrow">CREATE</span><h2>{modeLabels[mode]} generation</h2></div><span className="forge-badge">{availableModels.length} model{availableModels.length === 1 ? '' : 's'}</span></div><label className="forge-field"><span>Model</span><select aria-label="Forge model" value={selectedModel} onChange={(event) => void saveSelection(event.target.value)} disabled={loading || selectionSaving || !availableModels.length}>{savedSelection && !selectedAvailable && <option value={selectedModel}>{savedSelection.modelId} (unavailable)</option>}{availableModels.map((model) => <option key={`${model.connectionId}:${model.modelId}`} value={modelKey(model)}>{model.label}</option>)}</select></label>{savedUnavailableReason && <p className="forge-error" role="alert">Saved model unavailable: {savedUnavailableReason}</p>}{selectionSaving && <p role="status">Saving model selection…</p>}{selectionError && <p className="forge-error" role="alert">{selectionError}</p>}<label className="forge-field forge-prompt"><span>{mode === 'music' ? 'Musical direction' : 'Prompt'}</span><textarea aria-label={mode === 'audio' ? 'Script' : mode === 'music' ? 'Musical direction' : 'Prompt'} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder={mode === 'audio' ? 'Enter the words to speak…' : mode === 'music' ? 'Describe the music to create…' : `Describe the ${mode} to manufacture…`} /><small>{mode === 'audio' ? 'Verbatim script' : mode === 'music' ? 'Style, mood, tempo, and arrangement guidance' : 'Prompt'}</small></label>{mode === 'music' && <label className="forge-field forge-prompt"><span>Lyrics <em>(optional)</em></span><textarea aria-label="Lyrics" value={lyrics} onChange={(event) => setLyrics(event.target.value)} placeholder="Add words for the song…" /><small>Lyrics are supplied as guidance and are not guaranteed verbatim.</small></label>}<div className="forge-actions">{(mode !== 'music' || availableModels.length > 0) && <button className="forge-primary" type="button" onClick={() => void submit()} disabled={loading || selectionSaving || busy || !selectedAvailable || !prompt.trim()}>{busy ? 'Starting…' : `Generate ${modeLabels[mode]}`}</button>}{notice && <span className="forge-notice" role="status">{notice}</span>}</div>{error && <p className="forge-error" role="alert">{error}</p>}{!loading && !availableModels.length && <div className="forge-empty"><strong>{mode === 'video' ? 'Video generation is unavailable' : mode === 'music' ? 'No music model configured' : `No ${modeLabels[mode].toLowerCase()} models available`}</strong><span>{modeUnavailableReason ?? (mode === 'video' ? 'This release does not have a video provider contract.' : mode === 'music' ? 'Music generation is not configured.' : 'Configure a compatible model connection to use this mode.')}</span></div>}
      {mode === 'video' && catalog?.sourceAttachments && <p className="forge-capability-note">Source attachments: unavailable — {catalog.sourceAttachments.reason ?? 'not supported by this release.'}</p>}</section><section className="forge-preview" aria-label="Creation viewer"><div className="forge-panel-head"><div><span className="eyebrow">OUTPUT</span><h2>{selectedJob ? jobLabel(selectedJob) : 'Preview'}</h2></div>{selectedJob && <span className={`forge-status ${selectedJob.status}`}>{selectedJob.status}</span>}</div>{showRecents && <div className="forge-recent-details">{error && <p role="alert" className="forge-error">{error}</p>}{notice && <p role="status">{notice}</p>}{selectedJob && <><p>{selectedJob.prompt}</p><small>{selectedJob.modelId} · {new Date(selectedJob.createdAt).toLocaleString()}</small></>}</div>}{selectedJob?.artifacts?.length ? <div className="forge-artifacts">{selectedJob.artifacts.map((artifact) => <article className="forge-artifact" key={artifact.id}><ArtifactOutput key={JSON.stringify([artifact.id, artifact.previewUrl, artifact.downloadUrl])} fetchMedia={owned.fetch} artifact={artifact} /><footer><strong>{artifact.name}</strong><div><button type="button" onClick={() => void attach(artifact)} disabled={!sessionId}>Attach to conversation</button></div></footer></article>)}</div> : <div className="forge-placeholder"><span aria-hidden="true">✦</span><strong>{selectedJob ? selectedJob.status === 'failed' ? 'Generation failed' : selectedJob.status === 'interrupted' ? 'Generation interrupted' : 'Preparing your artifact…' : 'Your creation will appear here'}</strong>{selectedJob?.status === 'failed' ? <FailureDetails job={selectedJob} /> : <small>{selectedJob?.error ?? 'Forge uses the full workspace for the work, and keeps the result close at hand.'}</small>}</div>}</section>
    <section className="forge-history"><div className="forge-panel-head"><div><span className="eyebrow">HISTORY</span><h2>{showRecents ? `Recent creations (${jobs.length})` : 'Recent creations'}</h2></div><button type="button" disabled={loading || selectionSaving} onClick={() => void load()}>Refresh</button></div>{recentJobs.length ? <div className="forge-jobs" role="region" aria-label="Recent creations list" tabIndex={0}>{recentJobs.map((job) => <button type="button" key={job.id} className={selectedJob?.id === job.id ? 'selected' : ''} onClick={() => setSelectedJobId(job.id)} aria-label={`${jobLabel(job)} ${job.status}: ${job.prompt}`}><span className={`forge-status ${job.status}`}>{job.status}</span><strong>{showRecents ? `${jobLabel(job)} · ${job.modelId}` : job.modelId}</strong><span title={job.prompt}>{job.prompt}</span><time>{new Date(job.createdAt).toLocaleString()}</time></button>)}</div> : <p className="forge-muted">{loading ? 'Loading creations…' : showRecents ? 'No recent creations.' : `No recent ${modeLabels[mode].toLowerCase()} creations.`}</p>}</section>
    </div>
  </main>;
}
