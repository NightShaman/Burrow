import { getBasicAuthHeader } from './auth';
import type { ApiTarget } from './apiTargets';

export type SetupStatus = {
  ok: boolean;
  installed: boolean;
  configured: boolean;
  wizardStep: 'fresh' | 'incomplete' | 'ready';
  blockers: string[];
};

export type RuntimeHealth = {
  ok: boolean;
  /** Calendar release identifier reported by the connected Burrow runtime. */
  version?: string;
  traces?: {
    count?: number;
    allocatedBytes?: number;
    logicalBytes?: number;
    warnings?: string[];
  };
};

export type RuntimeMetricFileSystem = {
  totalBytes: number | null;
  usedBytes: number | null;
  availableBytes: number | null;
  error: string | null;
};

export type RuntimeMetricCpu = {
  userMicros: number | null;
  systemMicros: number | null;
  totalMicros: number | null;
  percent: number | null;
  sampleWindowMs: number | null;
};

export type RuntimeMetrics = {
  ok: boolean;
  cache?: { ageMs?: number; ttlMs?: number };
  filesystem: RuntimeMetricFileSystem;
  process: {
    rssBytes: number | null;
    heapUsedBytes: number | null;
    heapTotalBytes: number | null;
    externalBytes: number | null;
    uptimeSeconds: number | null;
    cpu: RuntimeMetricCpu;
  };
  load: {
    oneMinute: number | null;
    fiveMinutes: number | null;
    fifteenMinutes: number | null;
  };
  settingsDatabase: {
    databaseBytes: number | null;
    walBytes: number | null;
    shmBytes: number | null;
    totalBytes: number | null;
    error: string | null;
  };
};

export type RuntimeAgent = {
  id: string;
  name: string;
  enabled: boolean;
  avatar?: string | null;
  executionEnvironment?: { kind: 'local' | 'gateway'; hostId?: string; workspaceRoot: string } | null;
};

export type AgentStatus = {
  sessionId: string;
  parentSessionId?: string | null;
  label?: string;
  status?: string;
  since?: string;
  subagentId?: string;
};

export type ContextStatus = {
  recall?: {
    requested?: boolean;
    used?: boolean;
    scope?: string | null;
    sourceCount?: number;
    searchedSessionCount?: number;
  };
  context?: {
    estimatedTokens?: number | null;
    capacityTokens?: number | null;
    usageRatio?: number | null;
    percent?: number | null;
    pressure?: 'ok' | 'watch' | 'compress' | 'blocked' | string;
    source?: string;
  };
  compaction?: {
    active?: boolean;
    summarizedTurnCount?: number;
    rawRecentTurnCount?: number;
    next?: { ready?: boolean; reason?: string; eligibleTurnCount?: number };
    last?: { sourceTurnCount?: number; reason?: string; rawTailTurnCount?: number };
  };
};

export type RuntimeModel = {
  id: string;
  selected?: boolean;
  displayName?: string;
  reasoningEfforts?: string[];
  defaultReasoningEffort?: string;
  contextWindow?: number;
  manual?: boolean;
  acceptedInput?: ('text' | 'image')[];
  inputCapabilityOverrides?: Partial<Record<'text' | 'image', 'auto' | 'enabled' | 'disabled'>>;
  discoveredInput?: ('text' | 'image')[];
  acceptedInputOverride?: ('text' | 'image')[];
};

export type AnthropicUsageWindow = { key: string; usedPercent: number; resetAt?: string | null };
export type AnthropicUsage = { windows: AnthropicUsageWindow[] };
export type OpenAiUsageWindow = { key: string; label: string; usedPercent: number | null; resetAt?: string | null; windowSeconds?: number | null };
export type OpenAiUsage = {
  planType?: string | null;
  blocked?: boolean;
  reachedType?: string | null;
  windows: OpenAiUsageWindow[];
  credits?: { hasCredits?: boolean | null; unlimited?: boolean | null; balance?: number | null; overageLimitReached?: boolean } | null;
};

export type ModelConnection = {
  id: string;
  provider: string;
  apiType: string;
  baseUrl: string;
  models: RuntimeModel[];
  apiKeyConfigured: boolean;
  authConfigured?: boolean;
  auth?: { type?: string | null; source?: string | null; expiresAt?: string | null };
};

export type MemoryConnection = {
  id: string;
  provider: string;
  baseUrl: string;
  apiKeyConfigured: boolean;
};

export type SessionSummary = {
  id: string;
  summary?: string;
  updatedAt?: string;
  archived?: boolean;
  turnCount?: number;
  parentSessionId?: string | null;
  ownerTaskId?: string | null;
  completedAt?: string | null;
  metadata?: { kind?: 'main' | 'task' | 'subagent' | string; retentionDays?: number; archivedAt?: string | null };
};

export type RetentionPlan = {
  policy?: { mainMaxAgeDays?: number; taskMaxAgeDays?: number; subagentMaxAgeDays?: number; traceMaxAgeDays?: number; traceMaxBytes?: number; sessionPolicies?: Record<string, unknown> };
  counts?: { sessions?: number; traces?: number; traceBytes?: number; traceLogicalBytes?: number; deleteSessions?: number; deleteTraces?: number; deleteTraceBytes?: number; deleteTraceLogicalBytes?: number };
  delete?: { sessions?: Array<{ id: string; kind?: string; reasons?: string[] }>; traces?: Array<{ id: string; allocatedBytes?: number; logicalBytes?: number; reasons?: string[] }> };
  dryRun?: boolean;
};

export type ToolActivityItem = { id: string; label: string; detail?: string; status?: 'pending' | 'ok' | 'error' };
export type ToolActivity = { runId?: string | null; status?: 'running' | 'ok' | 'warn'; title?: string; summary?: string; items?: ToolActivityItem[] };
export type SessionToolActivity = { runId?: string | null; summary: string; items: Array<{ label: string; detail?: string; status: 'pending' | 'ok' | 'error'; count?: number }> };
export type ProgressEntry = { id: string; text: string; ts: string; modelCall?: number; status?: 'streaming' | 'complete' };
export type RunProgress = { items: ProgressEntry[]; status?: 'running' | 'complete' | 'failed' | 'cancelled' | 'superseded' };
export type ActiveA2AActivity = {
  id: string;
  status: 'running' | 'streaming' | 'replied' | 'cancelled';
  startedAt?: string;
  updatedAt?: string;
  completedAt?: string;
  recipient?: { agentId?: string; sessionId?: string; runId?: string };
  parentAgentId?: string;
  messageMode?: string;
  progress?: Array<{ type?: string; data?: Record<string, unknown>; ts?: string }>;
};
export type ActiveChatRun = {
  runId: string;
  agentId: string;
  sessionId: string;
  status: string;
  phase?: string;
  progress?: Array<{ type?: string; data?: Record<string, unknown>; ts?: string }>;
  source?: string | null;
  a2a?: { parentAgentId?: string; parentRunId?: string; messageMode?: string } | null;
  a2aActivities?: ActiveA2AActivity[];
};
export type ActiveChatRunsResponse = { ok: boolean; runs: ActiveChatRun[] };

export type SessionAttachment = {
  index?: number;
  name: string;
  type: string;
  size?: number | null;
  encoding?: string;
};

export type SessionTurn = {
  type?: string;
  role?: string | null;
  content?: string;
  ts?: string;
  runId?: string | null;
  metadata?: {
    toolActivity?: ToolActivity;
    attachments?: SessionAttachment[];
    progress?: RunProgress;
    streamedAnswer?: string;
    kind?: string;
    fromAgentId?: string;
    fromAgentName?: string;
    toAgentId?: string;
    messageMode?: 'deliver' | 'request_reply' | 'reply' | string;
    direction?: 'inbound' | 'outbound' | string;
  };
};

export type ChatAttachment = {
  name: string;
  type: string;
  size: number;
  encoding: 'data-url';
  content: string;
};

export function attachmentDisplayName(file: File, ordinal = 1, timestamp = Date.now()): string {
  if (file.name.trim()) return file.name;
  const extension = file.type.split('/')[1]?.replace(/[^a-z0-9]+/gi, '') || 'bin';
  return `pasted-${timestamp}-${ordinal}.${extension}`;
}

export type ArchiveRunStatus = 'completed' | 'warning' | 'failed' | 'unverified' | 'incomplete';
export type ArchiveEvidenceItem = { text: string; status: 'observed' | 'validated' | 'failed' | 'unresolved' | 'unknown'; sourceRefs: string[] };
export type ArchiveRunDetail = {
  id: string; runId: string; agentId: string; agentName?: string | null; sessionId: string; status: ArchiveRunStatus;
  startedAt?: string | null; lastActivityAt?: string | null; completedAt?: string | null; objective?: string | null; request?: string | null; finalAnswer?: string | null; decision?: string | null; route?: Record<string, unknown> | null;
  counts: { observations: number; changes: number; verifications: number; unresolved: number; failures: number; toolActivities: number; subagents: number };
  evidence: { observations: ArchiveEvidenceItem[]; changes: ArchiveEvidenceItem[]; verifications: ArchiveEvidenceItem[]; unresolved: ArchiveEvidenceItem[]; failures: ArchiveEvidenceItem[] };
  context?: { budget: Record<string, unknown> | null; compression: { status?: 'applied' | 'not_needed' | 'failed' | 'not_recorded'; label?: string; detail?: string; reason?: string | null; summarizedTurnCount?: number | null; retainedTurnCount?: number | null; source?: string | null } | null; attachments: number; summary?: string | null; contextEvents?: Array<Record<string, unknown>>; attachmentManifest?: Array<Record<string, unknown>>; currentAttachmentManifest?: Array<Record<string, unknown>>; retainedAttachmentManifest?: Array<Record<string, unknown>> } | null;
  timeline: Array<{ kind: 'tool_call' | 'tool_result' | 'tool_trace' | string; status: string; ts?: string | null; summary: string; evidence: 'session_execution' | 'trace_receipt' | 'archive_inference' | string }>;
  references: { trace: Record<string, unknown> | null; sourceRefs: string[] };
  subagents: Array<{ id: string; status: string | null; phase: string | null; purpose: string; label?: string | null; createdAt: string | null; completedAt: string | null; model: Record<string, unknown> | null; result: { ok?: boolean; summary?: string; blockers?: number; warnings?: number; evidence?: number; artifacts?: number; changedFiles?: number; memoryWrites?: number; sideEffectsApplied?: boolean } | null; verification?: { status: 'passed' | 'failed' | 'failed_expected' | 'not_run'; expected: boolean; check: string | null; observed: string | null; actionRequired: boolean } | null; trace: Record<string, unknown> }>;
};
export type ArchiveRunListResponse = { ok: true; runs: ArchiveRunDetail[] };
export type ArchiveRunResponse = { ok: true; run: ArchiveRunDetail };

export type ChatSession = {
  id: string;
  turns?: SessionTurn[];
  activities?: SessionToolActivity[];
  metadata?: {
    conversationId?: string;
    transcriptGeneration?: string;
    resetAt?: string;
  };
};

export function createRequestHeaders(headers: HeadersInit = {}, defaultAccept = 'application/json'): Headers {
  const requestHeaders = new Headers(headers);
  if (!requestHeaders.has('accept')) requestHeaders.set('accept', defaultAccept);
  const authHeader = getBasicAuthHeader();
  if (authHeader && !requestHeaders.has('authorization')) requestHeaders.set('authorization', authHeader);
  return requestHeaders;
}

export function apiUrl(target: Pick<ApiTarget, 'baseUrl'> | undefined, path: string): string {
  if (!target?.baseUrl) return path;
  if (!path.startsWith('/')) throw new Error('API paths must start with /.');
  return `${target.baseUrl.replace(/\/$/, '')}${path}`;
}

let activeApiTarget: ApiTarget | undefined;

export function setActiveApiTarget(target: ApiTarget | undefined) {
  activeApiTarget = target?.baseUrl ? target : undefined;
}

export function fetchApi(path: string, init: RequestInit = {}): Promise<Response> {
  return activeApiTarget ? fetchApiForTarget(activeApiTarget, path, init) : fetch(path, { ...init, headers: createRequestHeaders(init.headers) });
}

export function fetchApiForTarget(target: Pick<ApiTarget, 'baseUrl'> | undefined, path: string, init: RequestInit = {}): Promise<Response> {
  if (!target?.baseUrl) return fetch(path, { ...init, headers: createRequestHeaders(init.headers) });
  const headers = new Headers(init.headers);
  if (!headers.has('accept')) headers.set('accept', 'application/json');
  // V1 targets have no credential contract. Never leak the local Burrow Basic
  // credential to another origin; target authentication can be added later as
  // an explicit contribution rather than inherited accidentally.
  headers.delete('authorization');
  return fetch(apiUrl(target, path), { ...init, headers });
}

export async function apiLocal<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { ...init, headers: createRequestHeaders(init.headers) });
  return parseApiResponse<T>(response);
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetchApi(path, init);
  return parseApiResponse<T>(response);
}

async function parseApiResponse<T>(response: Response): Promise<T> {
  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const contentType = response.headers.get('content-type') ?? '';
  const responseExcerpt = text.length > 500 ? `${text.slice(0, 500)}…` : text;
  let body: unknown = text;
  if (text && contentType.includes('application/json')) {
    try {
      body = JSON.parse(text);
    } catch {
      const error = new Error(response.ok ? 'invalid_json_response' : `HTTP ${response.status}`) as Error & { status?: number; details?: unknown };
      error.status = response.status;
      error.details = responseExcerpt;
      throw error;
    }
  }

  if (!response.ok || (body && typeof body === 'object' && (body as { ok?: unknown }).ok === false)) {
    const rawError = body && typeof body === 'object' ? (body as { error?: unknown }).error : body;
    const message = typeof rawError === 'string'
      ? rawError
      : rawError && typeof rawError === 'object'
        ? ((rawError as { message?: unknown; error?: unknown }).message || (rawError as { error?: unknown }).error || JSON.stringify(rawError))
        : `HTTP ${response.status}`;
    const error = new Error(String(message)) as Error & { status?: number; details?: unknown };
    error.status = response.status;
    error.details = rawError && typeof rawError === 'object'
      ? ((rawError as { details?: unknown }).details ?? responseExcerpt)
      : responseExcerpt;
    throw error;
  }
  return body as T;
}

export async function apiForTarget<T>(target: Pick<ApiTarget, 'baseUrl'> | undefined, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetchApiForTarget(target, path, init);
  return parseApiResponse<T>(response);
}

export async function downloadExport(categories: string[], password?: string): Promise<{ blob: Blob; filename: string }> {
  const response = await fetchApi('/api/export', {
    method: 'POST',
    headers: createRequestHeaders({
      accept: 'application/octet-stream, application/gzip',
      'content-type': 'application/json',
    }),
    body: JSON.stringify({ categories, ...(password ? { password } : {}) }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const rawError = body?.error;
    const message = typeof rawError === 'string' ? rawError : rawError?.message || `HTTP ${response.status}`;
    throw new Error(message);
  }
  const disposition = response.headers.get('content-disposition') || '';
  const filename = disposition.match(/filename="?([^";]+)"?/i)?.[1] || 'burrow-export.bin';
  return { blob: await response.blob(), filename };
}

export type ExportImportRequest = {
  payload: string;
  password?: string;
  confirm?: boolean;
  conflictPolicy?: 'error' | 'skip' | 'replace';
};

export async function importExport(request: ExportImportRequest, preview = false): Promise<Record<string, unknown>> {
  return api<Record<string, unknown>>(`/api/export/import${preview ? '/preview' : ''}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
}

export function createRunId(sessionId: string) {
  return `${sessionId}-${Date.now()}`;
}

function record(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}

export function textFromChatValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map(textFromChatValue).filter(Boolean).join('');
  if (typeof value !== 'object') return String(value);

  const item = value as Record<string, any>;
  const direct = textFromChatValue(item.text ?? item.answerText ?? item.delta ?? item.answer ?? item.value);
  if (direct) return direct;

  const content = textFromChatValue(item.content ?? item.message ?? item.output);
  if (content) return content;

  return '';
}

export function answerFromChatResult(result: unknown) {
  const value = record(result);
  const nested = record(value.result);
  const modelError = value.model?.error?.message || value.model?.error || nested.model?.error?.message || nested.model?.error || nested.error || value.error;
  const blockers = textFromChatValue(nested.blockers ?? value.blockers ?? nested.chatSupport?.blockers ?? value.chatSupport?.blockers);
  if (value.ok === false || value.model?.ok === false || nested.model?.ok === false || nested.decision === 'model_failed') {
    return `Request failed: ${textFromChatValue(modelError) || blockers || 'The runtime could not complete the message.'}`;
  }

  const answer = textFromChatValue(nested.answerText ?? value.answerText ?? nested.message ?? value.message ?? nested.content ?? value.content);
  return answer || 'The runtime completed without answer text. Please retry.';
}
