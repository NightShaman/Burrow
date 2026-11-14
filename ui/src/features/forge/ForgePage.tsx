import { useConfirm } from '../../app/ConfirmDialog';
import { rovingKeys } from '../../app/keyboardWidgets';
import { useOwnedApi } from '../../app/useOwnedApi';
import { ImagePreview } from '../../app/ImagePreview';
import { useEffect, useMemo, useRef, useState } from 'react';

import type { Agent, SavedProvider } from '../../app/types';
import './forge.css';
import './forge-motion.css';
import { ForgeGallery } from './ForgeGallery';
import { useForgeMotion } from './useForgeMotion';
import {
  defaultImageDraft,
  ForgeImageOptions,
  imageDraftError,
  imageDraftOptions,
  type ImageDraft,
  type ImageOutputFormat,
} from './ForgeImageOptions';

type ForgeModel = {
  connectionId: string;
  modelId: string;
  label: string;
  kind: 'image' | 'audio' | 'video';
  available: boolean;
  unavailableReason?: string | null;
  controls: string[];
  agentReferenceImage?: { available: boolean; reason?: string | null };
  referenceArtifacts?: { available: boolean; maxImages?: number; reason?: string | null };
  imageOptions?: { outputFormats: ImageOutputFormat[]; sizes: string[] };
};
type ForgeCatalog = {
  models: ForgeModel[];
  agentReferenceImages?: { agentId: string; agentName?: string; id: string }[];
  operatorReferenceImage?: { id: string } | null;
  music?: { available: boolean; reason?: string | null; models?: ForgeModel[] };
  sourceAttachments?: { available: boolean; reason?: string | null };
  video?: { available: boolean; reason?: string | null };
};
type Artifact = {
  id: string;
  kind: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  previewUrl?: string | null;
  downloadUrl?: string | null;
};
type ArtifactReference = { jobId: string; artifactId: string };
function eligibleVideoReference(job: Job, artifact: Artifact): boolean {
  return (
    job.status === 'succeeded' &&
    job.kind === 'image' &&
    artifact.kind === 'image' &&
    ['image/png', 'image/jpeg', 'image/webp'].includes(artifact.mimeType?.toLowerCase()) &&
    artifact.sizeBytes > 0 &&
    artifact.sizeBytes <= 20 * 1024 * 1024
  );
}
type ForgeErrorDetails = {
  stage: string;
  message: string;
  code?: string;
  httpStatus?: number;
  requestId?: string;
  truncated?: boolean;
  observedBytes?: number;
  maxBytes?: number;
};
type Job = {
  id: string;
  connectionId: string;
  modelId: string;
  kind: 'image' | 'audio' | 'video' | 'music';
  mode?: 'image' | 'music' | 'speech' | 'video' | null;
  prompt: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'interrupted';
  createdAt: string;
  updatedAt: string;
  error?: string | null;
  errorDetails?: ForgeErrorDetails | null;
  artifacts: Artifact[];
};

async function copyReference(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Local HTTP and denied clipboard access use the existing browser fallback.
  }
  const previous = document.activeElement;
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
  document.body.append(textarea);
  textarea.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    textarea.remove();
    if (previous instanceof HTMLElement) previous.focus();
  }
}

function safeDiagnosticText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/(bearer\s+)[^\s,;]+/gi, '$1[redacted]')
    .replace(/((?:api[_-]?key|token|secret|password)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]');
}

function FailureDetails({ job }: { job: Job }) {
  const details = job.errorDetails;
  if (!details)
    return <small>{job.error || 'Generation failed. No further details are available.'}</small>;
  const stage = safeDiagnosticText(details.stage);
  const message =
    safeDiagnosticText(details.message) || safeDiagnosticText(job.error) || 'Generation failed.';
  const code = safeDiagnosticText(details.code);
  const requestId = safeDiagnosticText(details.requestId);
  const httpStatus =
    Number.isInteger(details.httpStatus) && details.httpStatus! > 0
      ? details.httpStatus
      : undefined;
  return (
    <div className="forge-failure-details" aria-label="Failure details">
      <p>{message}</p>
      <dl>
        {stage && (
          <>
            <dt>Stage</dt>
            <dd>{stage}</dd>
          </>
        )}
        {code && (
          <>
            <dt>Code</dt>
            <dd>{code}</dd>
          </>
        )}
        {httpStatus && (
          <>
            <dt>HTTP</dt>
            <dd>{httpStatus}</dd>
          </>
        )}
        {requestId && (
          <>
            <dt>Request ID</dt>
            <dd>{requestId}</dd>
          </>
        )}
      </dl>
      {details.truncated === true && (
        <p className="forge-diagnostic-truncated">
          Provider error response truncated at ingestion
          {Number.isFinite(details.maxBytes) ? ` (budget: ${details.maxBytes} bytes` : ''}
          {Number.isFinite(details.observedBytes)
            ? `${Number.isFinite(details.maxBytes) ? '; ' : ' ('}at least ${details.observedBytes} bytes read`
            : ''}
          {Number.isFinite(details.maxBytes) || Number.isFinite(details.observedBytes) ? ')' : ''}.
        </p>
      )}
    </div>
  );
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

export function ArtifactOutput({
  artifact,
  fetchMedia,
}: {
  artifact: Artifact;
  fetchMedia: ReturnType<typeof useOwnedApi>['fetch'];
}) {
  const [src, setSrc] = useState('');
  const [previewState, setPreviewState] = useState('loading');
  const [downloadState, setDownloadState] = useState('idle');
  const [attempt, setAttempt] = useState(0);
  const resource = useMemo(
    () => ({
      active: true,
      abort: new AbortController(),
      urls: new Set<string>(),
      requests: new Map<string, Promise<string>>(),
    }),
    [artifact.id, artifact.previewUrl, artifact.downloadUrl, artifact.mimeType, fetchMedia],
  );
  const load = (source: string) => {
    const path = artifactPath(source);
    const cached = resource.requests.get(path);
    if (cached) return cached;
    const signal = resource.abort.signal;
    const request = fetchMedia(path, { signal, headers: { accept: artifact.mimeType || '*/*' } })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.blob();
      })
      .then((blob) => {
        if (!resource.active || signal.aborted) throw new Error('Artifact retired');
        const url = URL.createObjectURL(blob);
        resource.urls.add(url);
        return url;
      })
      .catch((error) => {
        if (resource.requests.get(path) === request) resource.requests.delete(path);
        throw error;
      });
    resource.requests.set(path, request);
    return request;
  };
  useEffect(() => {
    resource.active = true;
    if (resource.abort.signal.aborted) resource.abort = new AbortController();
    return () => {
      resource.active = false;
      resource.abort.abort();
      resource.urls.forEach((url) => URL.revokeObjectURL(url));
      resource.urls.clear();
      resource.requests.clear();
    };
  }, [resource]);
  useEffect(() => {
    let cancelled = false;
    setSrc('');
    setPreviewState('loading');
    setDownloadState('idle');
    if (artifact.previewUrl)
      void load(artifact.previewUrl)
        .then((url) => {
          if (!cancelled) {
            setSrc(url);
            setPreviewState('ready');
          }
        })
        .catch(() => {
          if (!cancelled) setPreviewState('failed');
        });
    return () => {
      cancelled = true;
    };
  }, [resource, attempt]);
  const download = async () => {
    if (!artifact.downloadUrl || downloadState === 'loading') return;
    setDownloadState('loading');
    try {
      const url = await load(artifact.downloadUrl);
      if (!resource.active) return;
      const link = document.createElement('a');
      link.href = url;
      link.download = artifact.name;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setDownloadState('idle');
    } catch {
      if (resource.active) setDownloadState('failed');
    }
  };
  return (
    <>
      {!artifact.previewUrl ? (
        <div className="forge-file">{artifact.name}</div>
      ) : previewState === 'failed' ? (
        <div className="forge-file">
          <p role="alert">Preview failed.</p>
          <button type="button" onClick={() => setAttempt((value) => value + 1)}>
            Retry preview
          </button>
        </div>
      ) : !src ? (
        <div className="forge-file" data-forge-preview-loading>
          Loading preview…
        </div>
      ) : artifact.kind === 'image' ? (
        <ImagePreview src={src} alt={artifact.name} />
      ) : artifact.kind === 'video' ? (
        <video controls src={src} />
      ) : artifact.kind === 'audio' ? (
        <audio controls src={src} />
      ) : (
        <div className="forge-file">{artifact.name}</div>
      )}
      {artifact.downloadUrl && (
        <div>
          {downloadState === 'failed' && <p role="alert">Download failed.</p>}
          <button
            type="button"
            disabled={downloadState === 'loading'}
            onClick={() => void download()}
          >
            {downloadState === 'loading'
              ? 'Preparing download…'
              : downloadState === 'failed'
                ? 'Retry download'
                : 'Download'}
          </button>
        </div>
      )}
    </>
  );
}

export function Forge({
  selectedAgentId,
  sessionId,
  savedProviders = [],
}: {
  agents?: Agent[];
  savedProviders?: Pick<SavedProvider, 'id' | 'provider'>[];
  selectedAgentId: string;
  sessionId: string;
}) {
  const confirm = useConfirm();
  const [deleting, setDeleting] = useState(false);
  const deletingRef = useRef(false);
  const deletedIds = useRef(new Set<string>());
  const machineRef = useRef<HTMLElement>(null);
  const submittedJobRef = useRef('');
  const owned = useOwnedApi();
  const api = owned.api;
  const [mode, setMode] = useState<'image' | 'video' | 'audio' | 'music'>('image');
  const [showRecents, setShowRecents] = useState(false);
  const [showGallery, setShowGallery] = useState(false);
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
  const [imageState, setImageState] = useState<{ scope: string; draft: ImageDraft } | null>(null);
  const [referenceState, setReferenceState] = useState<{
    scope: string;
    agentIds: string[];
    operator: boolean;
  } | null>(null);
  const [artifactReferenceState, setArtifactReferenceState] = useState<{
    scope: string;
    references: ArtifactReference[];
  } | null>(null);
  const [selectedJobId, setSelectedJobId] = useState('');
  const loadSequence = useRef(0);
  const activeAgentRef = useRef(selectedAgentId);
  const idempotencyRef = useRef<{ signature: string; key: string } | null>(null);

  useEffect(() => {
    activeAgentRef.current = selectedAgentId;
  }, [selectedAgentId]);

  const load = async () => {
    const sequence = ++loadSequence.current;
    setLoading(true);
    setError('');
    try {
      const [catalog, history, saved] = await Promise.all([
        api<ForgeCatalog>('/api/forge/catalog'),
        api<{ jobs: Job[] }>('/api/forge/jobs'),
        api<{ selections: Selections }>('/api/forge/selections'),
      ]);
      if (sequence !== loadSequence.current) return;
      setSelections(saved.selections ?? {});
      setCatalog(catalog);
      setModels(catalog.models ?? []);
      setJobs((history.jobs ?? []).filter((job) => !deletedIds.current.has(job.id)));
    } catch (e) {
      if (sequence === loadSequence.current)
        setError(`Could not load Forge: ${(e as Error).message}`);
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  };
  useEffect(() => {
    void load();
    return () => {
      ++loadSequence.current;
    };
  }, []);
  const modeModels = useMemo(() => {
    if (mode === 'music') return catalog?.music?.models ?? [];
    if (mode === 'audio') {
      const musicKeys = new Set(
        (catalog?.music?.models ?? []).map((m) => `${m.connectionId}:${m.modelId}`),
      );
      return models.filter(
        (m) => m.kind === 'audio' && !musicKeys.has(`${m.connectionId}:${m.modelId}`),
      );
    }
    return models.filter((m) => m.kind === mode);
  }, [catalog, models, mode]);
  const availableModels = useMemo(() => modeModels.filter((m) => m.available), [modeModels]);
  const unavailableModels = useMemo(() => modeModels.filter((m) => !m.available), [modeModels]);
  const modeUnavailableReason =
    mode === 'video'
      ? catalog?.video?.reason
      : mode === 'music'
        ? catalog?.music?.reason
        : unavailableModels[0]?.unavailableReason;
  const selectionMode: SelectionMode = mode === 'audio' ? 'speech' : mode;
  const savedSelection = selections[selectionMode];
  const selectedModel = savedSelection
    ? modelKey(savedSelection)
    : availableModels[0]
      ? modelKey(availableModels[0])
      : '';
  const selectedProvider = savedSelection?.connectionId ?? availableModels[0]?.connectionId ?? '';
  const providers = [...new Set(availableModels.map((model) => model.connectionId))].map((id) => {
    const name = savedProviders.find((provider) => provider.id === id)?.provider ?? id;
    const duplicateName = savedProviders.some(
      (provider) => provider.id !== id && provider.provider === name,
    );
    return { id, label: duplicateName ? `${name} · ${id}` : name };
  });
  const providerModels = availableModels.filter((model) => model.connectionId === selectedProvider);
  const selectedAvailable = availableModels.some((model) => modelKey(model) === selectedModel);
  const activeModel = availableModels.find((model) => modelKey(model) === selectedModel);
  const referenceAvailable =
    (mode === 'image' || mode === 'video') && activeModel?.agentReferenceImage?.available;
  const portraits = catalog?.agentReferenceImages ?? [];
  const referenceScope = JSON.stringify([mode, selectedModel]);
  const referenceAgentIds =
    referenceAvailable && referenceState?.scope === referenceScope
      ? referenceState.agentIds.filter((id) =>
          portraits.some((portrait) => portrait.agentId === id),
        )
      : [];
  const useOperatorReferenceImage = !!(
    referenceAvailable &&
    catalog?.operatorReferenceImage &&
    referenceState?.scope === referenceScope &&
    referenceState.operator
  );
  useEffect(() => {
    setReferenceState(null);
  }, [referenceScope]);
  const videoModels = models.filter((model) => model.kind === 'video' && model.available);
  const videoSelection = selections.video;
  const videoModel = videoSelection
    ? videoModels.find((model) => modelKey(model) === modelKey(videoSelection))
    : videoModels[0];
  const videoReferenceScope = videoModel ? modelKey(videoModel) : '';
  const artifactReferencesAvailable = !!videoModel?.referenceArtifacts?.available;
  const artifactReferences =
    artifactReferencesAvailable && artifactReferenceState?.scope === videoReferenceScope
      ? artifactReferenceState.references.filter((reference) => {
          const job = jobs.find((item) => item.id === reference.jobId);
          const artifact = job?.artifacts.find((item) => item.id === reference.artifactId);
          return job && artifact && eligibleVideoReference(job, artifact);
        })
      : [];
  const videoReferenceLimit = Math.min(6, videoModel?.referenceArtifacts?.maxImages ?? 6);
  const referenceCount =
    referenceAgentIds.length +
    Number(useOperatorReferenceImage) +
    (mode === 'video' ? artifactReferences.length : 0);
  const referenceError =
    mode === 'video' && referenceCount > videoReferenceLimit
      ? `Video supports up to ${videoReferenceLimit} reference images. Remove a reference to continue.`
      : '';
  useEffect(() => {
    setArtifactReferenceState(null);
  }, [videoReferenceScope]);
  const useArtifactReference = (job: Job, artifact: Artifact) => {
    if (!artifactReferencesAvailable || !eligibleVideoReference(job, artifact) || busy) return;
    const exists = artifactReferences.some(
      (ref) => ref.jobId === job.id && ref.artifactId === artifact.id,
    );
    if (
      !exists &&
      (mode === 'video' ? referenceCount : artifactReferences.length) >= videoReferenceLimit
    ) {
      setError(
        `Video supports up to ${videoReferenceLimit} reference images. Remove a reference to continue.`,
      );
      return;
    }
    setArtifactReferenceState({
      scope: videoReferenceScope,
      references: exists
        ? artifactReferences
        : [...artifactReferences, { jobId: job.id, artifactId: artifact.id }],
    });
    setMode('video');
    setShowRecents(false);
    setSelectedJobId('');
    setError('');
    setNotice('');
  };
  const imageCapability = mode === 'image' ? activeModel?.imageOptions : undefined;
  const imageScope = JSON.stringify([mode, selectedModel, imageCapability]);
  const imageDraft =
    imageState?.scope === imageScope
      ? imageState.draft
      : defaultImageDraft(imageCapability?.outputFormats);
  const imageError = imageCapability ? imageDraftError(imageDraft) : '';
  useEffect(() => {
    setImageState(null);
  }, [imageScope]);

  const savedUnavailableReason =
    savedSelection && !selectedAvailable
      ? (modeModels.find((model) => modelKey(model) === selectedModel)?.unavailableReason ??
        'This saved model is no longer in the catalog. Choose another model.')
      : '';
  const saveSelection = async (key: string) => {
    if (loading || selectionSavingRef.current) return;
    const model = availableModels.find((item) => modelKey(item) === key);
    if (!model) return;
    selectionSavingRef.current = true;
    setSelectionSaving(true);
    setSelectionError('');
    const sequence = loadSequence.current;
    try {
      const result = await api<{ selections: Selections }>('/api/forge/selections', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          mode: selectionMode,
          connectionId: model.connectionId,
          modelId: model.modelId,
        }),
      });
      if (sequence === loadSequence.current) setSelections(result.selections);
    } catch (e) {
      if (sequence === loadSequence.current)
        setSelectionError(
          `Could not save model selection: ${(e as Error).message}. Your previous selection is unchanged; choose again to retry.`,
        );
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
          if (!cancelled)
            setJobs((result.jobs ?? []).filter((job) => !deletedIds.current.has(job.id)));
        })
        .catch(() => {});
    }, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [jobs]);
  const [recentNow, setRecentNow] = useState(() => Date.now());
  useEffect(() => {
    if (!showRecents) return;
    setRecentNow(Date.now());
    const timer = window.setInterval(() => setRecentNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [showRecents]);
  const orderedJobs = [...jobs].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const scopedJobs = showRecents
    ? orderedJobs.filter((job) => {
        const age = Math.max(recentNow, Date.now()) - Date.parse(job.createdAt);
        return age >= 0 && age <= 24 * 60 * 60 * 1000;
      })
    : orderedJobs.filter((job) => jobMode(job) === mode).slice(0, 5);
  const recentJobs = scopedJobs;
  const selectedJob = scopedJobs.find((job) => job.id === selectedJobId) ?? scopedJobs[0];
  const motion = useForgeMotion(machineRef, selectedJob, submittedJobRef.current, () => {
    const output = machineRef.current?.querySelector('.forge-output-content');
    if (!output || output.querySelector('[data-forge-preview-loading]')) return false;
    return [...output.querySelectorAll('img')].every((image) => image.complete);
  });
  const submit = async () => {
    const model = availableModels.find((item) => modelKey(item) === selectedModel);
    const submittedPrompt = mode === 'music' ? composeMusicPrompt(prompt, lyrics) : prompt.trim();
    if (
      loading ||
      busy ||
      selectionSavingRef.current ||
      !model ||
      !submittedPrompt ||
      imageError ||
      referenceError
    )
      return;
    const imageOptions = imageCapability
      ? imageDraftOptions(imageDraft, imageState?.scope === imageScope)
      : undefined;
    if (
      imageOptions &&
      (!imageCapability?.outputFormats.includes(imageOptions.outputFormat) ||
        (imageOptions.size && !imageCapability.sizes.includes(imageOptions.size)))
    ) {
      setError(
        'These image options are unavailable for the selected model. Choose another format or size.',
      );
      return;
    }
    const references = {
      ...(mode === 'video' && artifactReferences.length
        ? { referenceArtifacts: artifactReferences }
        : {}),
      ...(referenceAgentIds.length ? { referenceAgentIds } : {}),
      ...(useOperatorReferenceImage ? { useOperatorReferenceImage: true } : {}),
    };
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const requestSignature = JSON.stringify([
        mode,
        model.connectionId,
        model.modelId,
        submittedPrompt,
        imageOptions,
        references,
      ]);
      const existing = idempotencyRef.current;
      const idempotencyKey = existing?.signature === requestSignature ? existing.key : newKey();
      idempotencyRef.current = { signature: requestSignature, key: idempotencyKey };
      const result = await api<{ job: Job }>('/api/forge/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          connectionId: model.connectionId,
          modelId: model.modelId,
          prompt: submittedPrompt,
          ...(imageOptions ? { imageOptions } : {}),
          ...references,
          idempotencyKey,
        }),
      });
      submittedJobRef.current = result.job.id;
      setJobs((current) => [result.job, ...current.filter((job) => job.id !== result.job.id)]);
      setSelectedJobId(result.job.id);
      setPrompt('');
      setLyrics('');
      setImageState(null);
      setReferenceState(null);
      setArtifactReferenceState(null);
      setNotice('Forge job accepted.');
      idempotencyRef.current = null;
    } catch (e) {
      setError(`Could not start generation: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  const deleteJob = async (job: Job) => {
    if (deletingRef.current || job.status === 'queued' || job.status === 'running') return;
    deletingRef.current = true;
    try {
      if (
        !(await confirm({
          title: 'Delete creation?',
          message:
            'This permanently deletes the job and its media from Forge. Calls, prompts, and outcomes remain in Archive.',
          confirmLabel: 'Delete creation',
          tone: 'danger',
        }))
      )
        return;
      setDeleting(true);
      setError('');
      setNotice('');
      await api(`/api/forge/jobs/${encodeURIComponent(job.id)}`, { method: 'DELETE' });
      deletedIds.current.add(job.id);
      setJobs((current) => current.filter((item) => item.id !== job.id));
      setSelectedJobId((current) => (current === job.id ? '' : current));
      setNotice('Creation deleted. Execution evidence remains in Archive.');
      try {
        const history = await api<{ jobs: Job[] }>('/api/forge/jobs');
        setJobs((history.jobs ?? []).filter((item) => !deletedIds.current.has(item.id)));
      } catch (cause) {
        setError(`Creation deleted, but could not refresh Forge: ${(cause as Error).message}`);
      }
    } catch (cause) {
      setError(`Could not delete creation: ${(cause as Error).message}`);
    } finally {
      deletingRef.current = false;
      setDeleting(false);
    }
  };
  const attach = async (artifact: Artifact) => {
    const agentAtStart = selectedAgentId;
    if (!selectedJob || !sessionId || !agentAtStart) return;
    try {
      const resourceAgentId = agentAtStart;
      await api(`/api/forge/jobs/${encodeURIComponent(selectedJob.id)}/attach`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agentId: resourceAgentId, sessionId, artifactId: artifact.id }),
      });
      if (activeAgentRef.current === agentAtStart)
        setNotice('Attached to the current conversation.');
    } catch (e) {
      if (activeAgentRef.current === agentAtStart)
        setError(`Could not attach artifact: ${(e as Error).message}`);
    }
  };
  return (
    <main ref={machineRef} className="forge-page forge-machine">
      <header className="forge-heading">
        <div>
          <h1>The Phantasm Forge</h1>
          <p>Manufacture sights, sounds, and moving lies.</p>
        </div>
        <div
          className="forge-modes"
          role="tablist"
          aria-label="Forge modes"
          onKeyDown={(event) => rovingKeys(event, '[role="tab"]')}
        >
          {(['image', 'video', 'audio', 'music'] as const).map((item) => (
            <button
              key={item}
              role="tab"
              tabIndex={!showGallery && !showRecents && mode === item ? 0 : -1}
              aria-selected={!showGallery && !showRecents && mode === item}
              className={!showGallery && !showRecents && mode === item ? 'active' : ''}
              onClick={() => {
                setShowGallery(false);
                setMode(item);
                setShowRecents(false);
              }}
            >
              {item === 'image' ? '▧' : item === 'video' ? '◉' : item === 'audio' ? '◌' : '♫'}
              <span>{modeLabels[item]}</span>
            </button>
          ))}
          <button
            role="tab"
            tabIndex={!showGallery && showRecents ? 0 : -1}
            aria-selected={!showGallery && showRecents}
            className={!showGallery && showRecents ? 'active' : ''}
            onClick={() => {
              setShowGallery(false);
              setShowRecents(true);
            }}
          >
            ◷<span>Recents</span>
          </button>
          <button
            role="tab"
            tabIndex={showGallery ? 0 : -1}
            aria-selected={showGallery}
            className={showGallery ? 'active' : ''}
            onClick={() => setShowGallery(true)}
          >
            ▧<span>Gallery</span>
          </button>
        </div>
      </header>
      {showGallery && (
        <ForgeGallery
          renderArtifact={(artifact) => (
            <ArtifactOutput artifact={artifact} fetchMedia={owned.fetch} />
          )}
        />
      )}
      <div hidden={showGallery} className={`forge-grid${showRecents ? ' forge-recents-grid' : ''}`}>
        <canvas className="forge-seam-sparks" aria-hidden="true" />
        <section className="forge-studio" hidden={showRecents}>
          <div className="forge-panel-head">
            <div>
              <span className="eyebrow">CREATE</span>
              <h2>{modeLabels[mode]} generation</h2>
            </div>
            <span className="forge-badge">
              {availableModels.length} model{availableModels.length === 1 ? '' : 's'}
            </span>
          </div>
          <div className="forge-model-selectors">
            <label className="forge-field">
              <span>Provider</span>
              <select
                aria-label="Forge provider"
                value={selectedProvider}
                onChange={(event) => {
                  const model = availableModels.find(
                    (item) => item.connectionId === event.target.value,
                  );
                  if (model) void saveSelection(modelKey(model));
                }}
                disabled={loading || selectionSaving || !providers.length}
              >
                {selectedProvider &&
                  !providers.some((provider) => provider.id === selectedProvider) && (
                    <option value={selectedProvider}>
                      {savedProviders.find((provider) => provider.id === selectedProvider)
                        ?.provider ?? selectedProvider}{' '}
                      (unavailable)
                    </option>
                  )}
                {providers.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="forge-field">
              <span>Model</span>
              <select
                aria-label="Forge model"
                value={selectedModel}
                onChange={(event) => void saveSelection(event.target.value)}
                disabled={loading || selectionSaving || !providerModels.length}
              >
                {savedSelection && !selectedAvailable && (
                  <option value={selectedModel}>{savedSelection.modelId} (unavailable)</option>
                )}
                {providerModels.map((model) => (
                  <option key={`${model.connectionId}:${model.modelId}`} value={modelKey(model)}>
                    {model.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {savedUnavailableReason && (
            <p className="forge-error" role="alert">
              Saved model unavailable: {savedUnavailableReason}
            </p>
          )}
          {selectionSaving && <p role="status">Saving model selection…</p>}
          {selectionError && (
            <p className="forge-error" role="alert">
              {selectionError}
            </p>
          )}
          {imageCapability && imageCapability.outputFormats.length > 0 && (
            <ForgeImageOptions
              draft={imageDraft}
              formats={imageCapability.outputFormats}
              sizes={imageCapability.sizes}
              disabled={loading || selectionSaving || busy}
              onChange={(draft) => setImageState({ scope: imageScope, draft })}
            />
          )}
          {referenceAvailable && (portraits.length > 0 || catalog?.operatorReferenceImage) && (
            <fieldset className="forge-references" disabled={loading || selectionSaving || busy}>
              <legend>Reference photos</legend>
              <div className="forge-reference-options">
                {portraits.map((portrait) => (
                  <label key={portrait.agentId}>
                    <input
                      type="checkbox"
                      aria-label={`Use ${portrait.agentName || portrait.agentId} reference photo`}
                      checked={referenceAgentIds.includes(portrait.agentId)}
                      disabled={
                        mode === 'video' &&
                        referenceCount >= videoReferenceLimit &&
                        !referenceAgentIds.includes(portrait.agentId)
                      }
                      onChange={(event) =>
                        setReferenceState({
                          scope: referenceScope,
                          agentIds: event.target.checked
                            ? [...referenceAgentIds, portrait.agentId]
                            : referenceAgentIds.filter((id) => id !== portrait.agentId),
                          operator: useOperatorReferenceImage,
                        })
                      }
                    />
                    <span>{portrait.agentName || portrait.agentId}</span>
                  </label>
                ))}
                {catalog?.operatorReferenceImage && (
                  <label>
                    <input
                      type="checkbox"
                      aria-label="Use operator reference photo"
                      checked={useOperatorReferenceImage}
                      disabled={
                        mode === 'video' &&
                        referenceCount >= videoReferenceLimit &&
                        !useOperatorReferenceImage
                      }
                      onChange={(event) =>
                        setReferenceState({
                          scope: referenceScope,
                          agentIds: referenceAgentIds,
                          operator: event.target.checked,
                        })
                      }
                    />
                    <span>Operator</span>
                  </label>
                )}
              </div>
            </fieldset>
          )}
          {mode === 'video' && artifactReferencesAvailable && (
            <fieldset className="forge-references" disabled={loading || selectionSaving || busy}>
              <legend>Forge image references</legend>
              {artifactReferences.length > 0 && (
                <ul className="forge-artifact-references">
                  {artifactReferences.map((reference) => {
                    const artifact = jobs
                      .find((job) => job.id === reference.jobId)
                      ?.artifacts.find((item) => item.id === reference.artifactId);
                    return (
                      <li key={JSON.stringify(reference)}>
                        <span>{artifact?.name}</span>
                        <button
                          type="button"
                          className="forge-reference-action"
                          aria-label={`Remove ${artifact?.name} reference`}
                          onClick={() =>
                            setArtifactReferenceState({
                              scope: videoReferenceScope,
                              references: artifactReferences.filter((item) => item !== reference),
                            })
                          }
                        >
                          Remove
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
              <button
                type="button"
                className="forge-reference-action"
                disabled={referenceCount >= videoReferenceLimit}
                onClick={() => {
                  setShowRecents(true);
                  setError('');
                  setNotice('');
                }}
              >
                Add Forge image
              </button>
            </fieldset>
          )}
          {referenceError && (
            <p className="forge-error" role="alert">
              {referenceError}
            </p>
          )}
          <label className="forge-field forge-prompt">
            <span>{mode === 'music' ? 'Musical direction' : 'Prompt'}</span>
            <textarea
              aria-label={
                mode === 'audio' ? 'Script' : mode === 'music' ? 'Musical direction' : 'Prompt'
              }
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder={
                mode === 'audio'
                  ? 'Enter the words to speak…'
                  : mode === 'music'
                    ? 'Describe the music to create…'
                    : `Describe the ${mode} to manufacture…`
              }
            />
            <small>
              {mode === 'audio'
                ? 'Verbatim script'
                : mode === 'music'
                  ? 'Style, mood, tempo, and arrangement guidance'
                  : 'Prompt'}
            </small>
          </label>
          {mode === 'music' && (
            <label className="forge-field forge-prompt">
              <span>
                Lyrics <em>(optional)</em>
              </span>
              <textarea
                aria-label="Lyrics"
                value={lyrics}
                onChange={(event) => setLyrics(event.target.value)}
                placeholder="Add words for the song…"
              />
              <small>Lyrics are supplied as guidance and are not guaranteed verbatim.</small>
            </label>
          )}
          <div
            className="forge-pressure"
            aria-label="Theatrical pressure gauge, not generation progress"
          >
            <div className="forge-pressure-head">
              <span>CONTAINMENT PRESSURE</span>
              <strong data-forge-meter-state>OFFLINE</strong>
            </div>
            <div className="forge-meter-track" aria-hidden="true">
              <i className="forge-meter-needle" />
            </div>
            <div className="forge-meter-labels" aria-hidden="true">
              <span>WITHIN SPEC</span>
              <span>PROBABLY FINE</span>
            </div>
            <small>Pressure is theatrical. Job status isn't.</small>
          </div>
          <div className="forge-motion-control">
            <label>
              <input
                type="checkbox"
                checked={motion.enabled}
                onChange={(event) => motion.setEnabled(event.target.checked)}
              />
              Forge effects
            </label>
            <small>Turn off motion without stopping generation.</small>
          </div>
          <div className="forge-actions">
            {(mode !== 'music' || availableModels.length > 0) && (
              <button
                className="forge-primary"
                type="button"
                onClick={() => void submit()}
                disabled={
                  loading ||
                  selectionSaving ||
                  busy ||
                  !selectedAvailable ||
                  !prompt.trim() ||
                  !!imageError ||
                  !!referenceError
                }
              >
                {busy ? 'Starting…' : `Generate ${modeLabels[mode]}`}
              </button>
            )}
            {notice && (
              <span className="forge-notice" role="status">
                {notice}
              </span>
            )}
          </div>
          {error && (
            <p className="forge-error" role="alert">
              {error}
            </p>
          )}
          {!loading && !availableModels.length && (
            <div className="forge-empty">
              <strong>
                {mode === 'video'
                  ? 'Video generation is unavailable'
                  : mode === 'music'
                    ? 'No music model configured'
                    : `No ${modeLabels[mode].toLowerCase()} models available`}
              </strong>
              <span>
                {modeUnavailableReason ??
                  (mode === 'video'
                    ? 'Configure a compatible video model connection to use this mode.'
                    : mode === 'music'
                      ? 'Music generation is not configured.'
                      : 'Configure a compatible model connection to use this mode.')}
              </span>
            </div>
          )}
          <div className="forge-heat-seam" aria-hidden="true" />
        </section>
        <section className="forge-preview" aria-label="Creation viewer">
          <div className="forge-panel-head">
            <div>
              <span className="eyebrow">OUTPUT</span>
              <h2>{selectedJob ? jobLabel(selectedJob) : 'Preview'}</h2>
            </div>
            {selectedJob && (
              <div className="forge-output-actions">
                <span className={`forge-status ${selectedJob.status}`}>{selectedJob.status}</span>
                {selectedJob.status !== 'queued' && selectedJob.status !== 'running' && (
                  <button
                    type="button"
                    className="danger"
                    disabled={deleting}
                    onClick={() => void deleteJob(selectedJob)}
                  >
                    {deleting ? 'Deleting…' : 'Delete creation'}
                  </button>
                )}
              </div>
            )}
          </div>
          {showRecents && (
            <div className="forge-recent-details">
              {error && (
                <p role="alert" className="forge-error">
                  {error}
                </p>
              )}
              {notice && <p role="status">{notice}</p>}
              {selectedJob && (
                <>
                  <p>{selectedJob.prompt}</p>
                  <small>
                    {selectedJob.modelId} · {new Date(selectedJob.createdAt).toLocaleString()}
                  </small>
                </>
              )}
            </div>
          )}
          <div className="forge-viewer-body">
            <div className="forge-output-content">
              {selectedJob?.artifacts?.length ? (
                <div className="forge-artifacts">
                  {selectedJob.artifacts.map((artifact) => (
                    <article className="forge-artifact" key={artifact.id}>
                      <ArtifactOutput
                        key={JSON.stringify([
                          artifact.id,
                          artifact.previewUrl,
                          artifact.downloadUrl,
                        ])}
                        fetchMedia={owned.fetch}
                        artifact={artifact}
                      />
                      <footer>
                        <strong>{artifact.name}</strong>
                        <div>
                          {artifactReferencesAvailable &&
                            eligibleVideoReference(selectedJob, artifact) && (
                              <button
                                type="button"
                                className="forge-reference-action"
                                disabled={busy || selectionSaving}
                                onClick={() => useArtifactReference(selectedJob, artifact)}
                              >
                                Use as video reference
                              </button>
                            )}
                          {['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(
                            artifact.mimeType?.toLowerCase(),
                          ) &&
                            artifact.sizeBytes <= 20 * 1024 * 1024 && (
                              <button
                                type="button"
                                onClick={async () => {
                                  const copied = await copyReference(
                                    `[forge:${selectedJob.id}:${artifact.id}]`,
                                  );
                                  setNotice(copied ? 'Reference copied.' : '');
                                  setError(copied ? '' : 'Could not copy reference. Try again.');
                                }}
                              >
                                Copy reference
                              </button>
                            )}
                          <button
                            type="button"
                            onClick={() => void attach(artifact)}
                            disabled={!sessionId}
                          >
                            Attach to conversation
                          </button>
                        </div>
                      </footer>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="forge-placeholder">
                  <span aria-hidden="true">✦</span>
                  <strong>
                    {selectedJob
                      ? selectedJob.status === 'failed'
                        ? 'Generation failed'
                        : selectedJob.status === 'interrupted'
                          ? 'Generation interrupted'
                          : selectedJob.status === 'succeeded'
                            ? 'No artifact available'
                            : 'Preparing your artifact…'
                      : 'Your creation will appear here'}
                  </strong>
                  {selectedJob?.status === 'failed' ? (
                    <FailureDetails job={selectedJob} />
                  ) : (
                    <small>
                      {selectedJob?.error ??
                        'Forge uses the full workspace for the work, and keeps the result close at hand.'}
                    </small>
                  )}
                </div>
              )}
            </div>
            <canvas className="forge-blast" aria-hidden="true" />
          </div>
          <div className="forge-fastener" aria-hidden="true" />
          <div className="forge-flying-bolt" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M9 7l10 11-3 3L6 10z" fill="#7d858c" stroke="#252b32" />
              <path d="M1 6l5-5 7 3 1 7-5 5-7-3z" fill="#adb0af" stroke="#3d4449" />
              <path d="M5 5l4 4" stroke="#343c43" strokeWidth="2" />
              <path d="M11 13l4-3m-1 6 4-3m-1 6 4-3" stroke="#323940" />
            </svg>
          </div>
        </section>
        <section className="forge-history">
          <div className="forge-panel-head">
            <div>
              <span className="eyebrow">HISTORY</span>
              <h2>{showRecents ? `Last 24 hours (${recentJobs.length})` : 'Recent creations'}</h2>
            </div>
            <button type="button" disabled={loading || selectionSaving} onClick={() => void load()}>
              Refresh
            </button>
          </div>
          {recentJobs.length ? (
            <div
              className="forge-jobs"
              role="region"
              aria-label="Recent creations list"
              tabIndex={0}
            >
              {recentJobs.map((job) => (
                <button
                  type="button"
                  key={job.id}
                  className={selectedJob?.id === job.id ? 'selected' : ''}
                  onClick={() => setSelectedJobId(job.id)}
                  aria-label={`${jobLabel(job)} ${job.status}: ${job.prompt}`}
                >
                  <span className={`forge-status ${job.status}`}>{job.status}</span>
                  <strong>{showRecents ? `${jobLabel(job)} · ${job.modelId}` : job.modelId}</strong>
                  <span title={job.prompt}>{job.prompt}</span>
                  <time>{new Date(job.createdAt).toLocaleString()}</time>
                </button>
              ))}
            </div>
          ) : (
            <p className="forge-muted">
              {loading
                ? 'Loading creations…'
                : showRecents
                  ? 'No creations in the last 24 hours.'
                  : `No recent ${modeLabels[mode].toLowerCase()} creations.`}
            </p>
          )}
        </section>
      </div>
    </main>
  );
}
