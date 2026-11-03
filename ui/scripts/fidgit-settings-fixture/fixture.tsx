import React, { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Settings } from '../../src/features/settings/SettingsPage';
import { ConfirmProvider } from '../../src/app/ConfirmDialog';
import { UnsavedChangesProvider } from '../../src/app/UnsavedChanges';
import type { Agent, SavedProvider, SettingsTab, PanelId } from '../../src/app/types';
import type { ScheduledJob } from '../../src/features/settings/schedules';
import type { WorkflowWatch } from '../../src/features/settings/AgentWorkflowEvents';
import type { Theme } from '../../src/app/usePersistedLayout';
import '../../src/app.css';
// Outer shell mirrors App.tsx; use production CSS without fixture layout overrides.

const agents = [
  'Hatchet',
  'Smatchet',
  'Guido',
  'Fidgit',
  'Wicket',
  'Grizzle',
  'Mog',
  'Nix',
  'Tinker',
  'Scraps',
  'Bramble',
  'Cog',
  'Sprocket',
  'Rivet',
  'Fizzle',
  'Snag',
  'Thistle',
].map((name, i) => ({
  id: name.toLowerCase(),
  name,
  enabled: true,
  model: 'synthetic-general',
  provider: 'Synthetic OpenAI',
  color: i % 2 ? '#d946ef' : '#00c8b8',
  avatar: '',
  status: 'idle',
  description: 'Synthetic goblin ' + (i + 1),
})) as Agent[];
const githubToolNames = [
  'get_me',
  'search_repositories',
  'get_repository',
  'list_branches',
  'create_branch',
  'list_commits',
  'get_commit',
  'get_file_contents',
  'create_or_update_file',
  'push_files',
  'delete_file',
  'list_issues',
  'get_issue',
  'create_issue',
  'update_issue',
  'add_issue_comment',
  'list_issue_comments',
  'search_issues',
  'list_pull_requests',
  'get_pull_request',
  'create_pull_request',
  'update_pull_request',
  'merge_pull_request',
  'get_pull_request_diff',
  'get_pull_request_files',
  'get_pull_request_reviews',
  'create_pull_request_review',
  'add_review_comment',
  'request_reviewers',
  'list_workflows',
  'get_workflow',
  'list_workflow_runs',
  'get_workflow_run',
  'get_workflow_run_logs',
  'rerun_workflow',
  'cancel_workflow_run',
  'list_releases',
  'get_release',
  'create_release',
  'list_tags',
  'list_repository_collaborators',
  'get_repository_permissions',
  'list_notifications',
  'mark_notification_read',
  'search_code',
];
const githubTools = githubToolNames.map((name, i) => ({
  name,
  description:
    i % 3 === 0
      ? 'Inspect repository metadata, permissions, and related records for an explicitly selected owner and repository. Returns structured results with pagination and contextual identifiers.'
      : i % 3 === 1
        ? 'Read or update ' + name.replaceAll('_', ' ') + ' within the selected GitHub repository.'
        : 'Retrieve ' + name.replaceAll('_', ' ') + '.',
  inputSchema: {
    type: 'object',
    properties: { owner: { type: 'string' }, repo: { type: 'string' } },
  },
}));
const mcpConnections = [
  {
    id: 'github',
    name: 'GitHub MCP',
    transport: 'http',
    baseUrl: 'https://github-mcp.invalid',
    command: null,
    args: [],
    enabled: true,
    apiKeyConfigured: true,
    tools: githubTools,
  },
  {
    id: 'docs',
    name: 'Documentation MCP',
    transport: 'http',
    baseUrl: 'https://docs-mcp.invalid',
    command: null,
    args: [],
    enabled: true,
    apiKeyConfigured: false,
    tools: [
      {
        name: 'search_documentation',
        description: 'Find reference documentation by keyword.',
        inputSchema: { type: 'object' },
      },
    ],
  },
];
const grantsByAgent: Record<
  string,
  { connectionId: string; toolName: string; enabled: boolean }[]
> = {};

const scheduledJobs: ScheduledJob[] = ['hatchet', 'thistle'].flatMap((agentId) =>
  Array.from({ length: 12 }, (_, i) => ({
    id: `${agentId}-job-${i + 1}`,
    agentId,
    name: `${agentId} scheduled briefing ${String(i + 1).padStart(2, '0')}`,
    jobKind: 'prompt' as const,
    prompt: `Prepare briefing ${i + 1}: inspect synthetic repository activity and summarize validated changes.`,
    taskId: null,
    extraInstructions: '',
    scheduleKind: 'cron' as const,
    cron: `${i * 5} 9 * * *`,
    runAt: null,
    enabled: i % 3 !== 0,
    modelConnectionId: null,
    model: null,
    effectiveTimezone: 'America/Chicago',
    nextRunAt: '2026-11-03T15:00:00Z',
    lastRun: {
      status: 'completed',
      completedAt: '2026-11-01T15:00:00Z',
      sessionId: `${agentId}-schedule-session-${i + 1}`,
      agentId,
      runId: `fixture-run-${i + 1}`,
    },
  })),
);
let workflowWatches: WorkflowWatch[] = ['hatchet', 'thistle'].flatMap((agentId) =>
  Array.from({ length: 12 }, (_, i) => ({
    id: `${agentId}-watch-${i + 1}`,
    agentId,
    repository: `synthetic/repository-${i + 1}`,
    workflow: `${agentId} release validation ${String(i + 1).padStart(2, '0')}`,
    sessionId: `${agentId}-ci-${i + 1}`,
    instruction: `Inspect completed workflow ${i + 1}, verify tests and summarize failures without changing deployment state.`,
    enabled: i % 3 !== 0,
  })),
);
let browserTabSuffix = 'Dev';
const dreamSettingsByAgent: Record<string, any> = {};
const models = (prefix: string) =>
  [
    'General',
    'Vision',
    'Reasoner',
    'Fast',
    'Atlas Long Context Research Preview',
    'Compact Code Assistant',
    'Multimodal Studio Image and Audio',
    'Reasoning Extended Deliberation',
    'Translation Specialist International',
    'Local Manual Compatibility',
  ].map((name, i) => ({
    id: `${prefix}-${i}`,
    displayName: `Synthetic ${name}`,
    selected: i < 3,
    acceptedInput: i === 1 || i === 6 ? ['text', 'image'] : ['text'],
    discoveredInput: i === 1 || i === 6 ? ['text', 'image'] : ['text'],
    acceptedOutput: i === 6 ? ['text', 'image', 'audio'] : ['text'],
    discoveredOutput: i === 6 ? ['text', 'image', 'audio'] : ['text'],
    contextWindow: i === 4 ? 500000 : 32768,
    discoveredContextWindow: i === 4 ? 500000 : 32768,
    outputTokens: i === 2 ? 16384 : 4096,
    manual: i === 9,
  }));
let providers = [
  {
    id: 'openai',
    provider: 'Synthetic OpenAI',
    apiType: 'openai-responses',
    url: 'https://synthetic-provider-0.invalid/v1',
    apiKey: '',
    apiKeyConfigured: true,
    models: ['openai-0', 'openai-1', 'openai-2'],
    connectionModels: models('openai'),
  },
  {
    id: 'google',
    provider: 'Synthetic Google',
    apiType: 'google-generative-language',
    url: 'https://synthetic-provider-1.invalid/v1',
    apiKey: '',
    apiKeyConfigured: true,
    models: ['google-0', 'google-1', 'google-2'],
    connectionModels: models('google'),
  },
  {
    id: 'anthropic',
    provider: 'Synthetic Anthropic',
    apiType: 'anthropic-messages',
    url: 'https://synthetic-provider-2.invalid/v1',
    apiKey: '',
    apiKeyConfigured: true,
    models: ['anthropic-0', 'anthropic-1', 'anthropic-2'],
    connectionModels: models('anthropic'),
  },
] as SavedProvider[];
providers.push(
  ...Array.from({ length: 6 }, (_, i) => ({
    id: `pool-${i + 1}`,
    provider: `Synthetic pool ${i + 1}`,
    apiType: i % 2 ? 'anthropic-lb' : 'openai-lb',
    url: '',
    apiKey: '',
    models: [],
    connectionModels: [],
    pool: {
      enabled: false,
      memberConnectionIds: [],
      sticky: true as const,
      preferEarlierReset: false as const,
    },
  })),
);
const skills = Array.from({ length: 8 }, (_, i) => ({
  id: `skill-${i + 1}`,
  name: i ? `Fixture skill ${i + 1}` : 'Fixture skill',
  description: `Synthetic skill ${i + 1}: evidence review and repository maintenance.`,
  content: `# Fixture skill ${i + 1}\n\nInspect synthetic evidence before acting. Preserve user intent and report verification limits.`,
  lifecycle: 'available',
  global: i === 7,
  source: 'text',
  version: '1.0.0',
  gitSource: null,
}));
const mods = Array.from({ length: 6 }, (_, i) => ({
  id: i ? `fixture-mod-${i + 1}` : 'fixture-mod',
  name: i ? `Fixture Mod ${i + 1}` : 'Fixture Mod',
  version: '1.0.0',
  runningVersion: '1.0.0',
  managedSkillVersion: '1.0.0',
  status: 'installed',
  enabled: i % 3 !== 2,
  source: `https://example.invalid/mod-${i + 1}.git`,
}));
const modSources = Array.from({ length: 4 }, (_, i) => ({
  id: `source-${i + 1}`,
  url: `https://example.invalid/synthetic-team/mod-source-${i + 1}.git`,
  status: 'ready',
  lastCheckedAt: '2026-11-01T15:00:00Z',
  credential: { configured: false },
}));
const apiTokens = Array.from({ length: 8 }, (_, i) => ({
  id: `token-${i + 1}`,
  name: `Synthetic diagnostics ${i + 1}`,
  scopes: ['diagnostics:read'],
  createdAt: '2026-10-01T12:00:00Z',
  expiresAt: i % 2 ? '2027-01-01T00:00:00Z' : null,
  lastUsedAt: '2026-11-01T12:00:00Z',
  revokedAt: null,
}));
const boundaries = Array.from({ length: 6 }, (_, i) => ({
  id: `boundary-${i + 1}`,
  enabled: true,
  type: 'path',
  pattern: `/synthetic/protected-${i + 1}/**`,
  match: 'glob',
  operations: ['write', 'delete'],
  reason: `Protect synthetic reference collection ${i + 1} from edits.`,
}));
const telemetryDestinations = Array.from({ length: 3 }, (_, i) => ({
  id: `telemetry-${i + 1}`,
  name: `Synthetic collector ${i + 1}`,
  provider: 'custom',
  enabled: true,
  endpoint: `https://collector-${i + 1}.invalid/otlp`,
  tracesEndpoint: '',
  metricsEndpoint: '',
  protocol: 'http/protobuf',
  tracesEnabled: true,
  metricsEnabled: true,
  metricsTemporality: 'cumulative',
  connection: {},
  tls: { verify: true },
  headersConfigured: false,
  credentialsConfigured: false,
  credentialFields: [],
}));
const documents = ['SOUL', 'RULES', 'ORIENTATION', 'PREFERENCES', 'TOOLS', 'DREAM_MEMORY'].map(
  (kind) => ({
    kind,
    markdown: `# ${kind}\n\nThis is a synthetic profile document.\n\n- Use clear evidence.\n- Preserve operator intent.\n- Keep work scoped.\n${Array.from({ length: 60 }, (_, i) => `\nSynthetic document paragraph ${i + 1}: preserve evidence and operator intent.\n`).join('')}`,
  }),
);
// Synthetic reference photo, independent from avatars and agent photos.
const referencePng =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAABF0lEQVR4nO2auw3CQBBEbUQDVOEGoAQCEioipCISAkqgArohtYSA/d7caeelyLvzPDYgzLzs9tPIbNABvFAADQXQUADNNmPo7fD49tL5eYzdNQd+kP3I/UmUSYyAKvoav4ZXwBx9jUfDdROHpHfOsQtEpXdOMwrEpvfMtAhkpDdPVgvkpbfN1wlkpzdsGf6rhEKgzenX7irTQMvTr9pYpoFuEQm0v37ke2s00DMUQEMBNBRAIxII/zVKiGRvjQZ6RirQ/ioSbizTwNS2BPmuSg1MrUpQbVE3kO2gnW+5hPIcDJON90CGg22m8QHH6341HPWX5XTRHlLsXahDKICGAmgogIYCaCiAhgJoKIAm8j9zEIZvYHiBN/IVQo3hfIgTAAAAAElFTkSuQmCC';
let operatorReferenceContent = 'data:image/png;base64,' + referencePng;
let operatorReferenceImage: {
  id: string;
  attachmentId: string;
  contentUrl: string;
  mimeType: string;
  fileName: string;
  sizeBytes: number;
  updatedAt: string;
} | null = {
  id: 'fixture-operator-reference',
  attachmentId: 'fixture-reference-png',
  contentUrl: '/api/operator/reference-image/content?revision=1',
  mimeType: 'image/png',
  fileName: 'synthetic-operator-reference.png',
  sizeBytes: 336,
  updatedAt: '2026-11-02T00:00:00Z',
};
type DiscoveryOutcome = 'fail' | 'success-current' | 'pending';
let discoveryOutcomes: DiscoveryOutcome[] = [];
let releaseDiscovery: ((outcome: DiscoveryOutcome) => void) | undefined;
let failNextModelSave = false;
const requests: { path: string; method: string }[] = [];
const errors: string[] = [];
window.addEventListener('error', (event) => errors.push(event.message));
window.addEventListener('unhandledrejection', (event) => errors.push(String(event.reason)));
window.fetch = (async (input, init) => {
  const path = String(input),
    method = init?.method ?? 'GET',
    body = init?.body ? JSON.parse(String(init.body)) : {};
  requests.push({ path, method });
  let data: any;
  if (path === '/api/mods')
    data = {
      mods: [
        {
          id: 'fixture-extension',
          name: 'Fixture extension',
          version: '1.0.0',
          ui: { settingsUrl: '/api/mods/fixture-extension/ui/settings.js' },
        },
      ],
    };
  else if (path === '/api/setup/status') data = { wizardStep: 'ready' };
  else if (path === '/api/settings/identities')
    data = { operator: { name: 'Goblin King', avatar: '' } };
  else if (path === '/api/settings/timezone') data = { timezone: 'America/Chicago' };
  else if (path === '/api/settings/browser-tab') {
    if (method === 'PUT') browserTabSuffix = body.suffix.trim();
    data = { suffix: browserTabSuffix };
  } else if (path === '/api/settings/ui-auth') data = { auth: { mode: 'none' } };
  else if (path === '/api/settings/model-connections' && method === 'POST') {
    if (failNextModelSave) {
      failNextModelSave = false;
      return Response.json({ error: 'Synthetic save unavailable' }, { status: 503 });
    }
    const id = body.id ?? `fixture-provider-${providers.length + 1}`,
      existing = providers.find((item) => item.id === id);
    const connection = {
      ...existing,
      id,
      provider: body.provider,
      apiType: body.apiType,
      url: body.baseUrl ?? existing?.url ?? '',
      apiKey: '',
      apiKeyConfigured: Boolean(body.apiKey) || existing?.apiKeyConfigured === true,
      models: (body.models ?? [])
        .filter((model: any) => model.selected !== false)
        .map((model: any) => model.id),
      connectionModels: body.models ?? [],
      ...(body.pool ? { pool: body.pool } : {}),
    } as SavedProvider;
    providers = existing
      ? providers.map((item) => (item.id === id ? connection : item))
      : [...providers, connection];
    data = { connection };
  } else if (path.endsWith('/discover')) {
    let outcome = discoveryOutcomes.shift();
    if (outcome === 'pending')
      outcome = await new Promise<DiscoveryOutcome>((resolve) => {
        releaseDiscovery = resolve;
      });
    if (outcome === 'fail')
      return Response.json({ error: 'Synthetic upstream unavailable' }, { status: 503 });
    data = {
      models:
        outcome === 'success-current'
          ? body.models
          : models('discovered').map((model) => ({ ...model, manual: false })),
    };
  } else if (path === '/api/settings/model-connections') data = { connections: providers };
  else if (path.endsWith('/profile-documents'))
    data = { documents, globalProfile: { useGlobalRules: true, useGlobalOrientation: true } };
  else if (path === '/api/settings/global-profile-documents')
    data = { documents: documents.filter((d) => ['RULES', 'ORIENTATION'].includes(d.kind)) };
  else if (path === '/api/settings/skills/git/preview')
    data = {
      preview: {
        name: 'Synthetic repository skill',
        description: 'Preview-only isolated fixture',
        content: '# Synthetic instructions\nReview synthetic evidence only.',
        suggestedId: 'synthetic-preview',
        storage: 'text',
        revision: 'fixture-revision',
        contentHash: 'sha256:fixture',
        files: [{ path: 'SKILL.md', bytes: 63, executable: false }],
        source: { ...body, timezone: 'UTC' },
      },
    };
  else if (path === '/api/settings/skills') data = { skills };
  else if (/^\/api\/settings\/skills\/[^/]+\/source$/.test(path)) data = { source: null };
  else if (path.match(/\/api\/agents\/[^/]+\/skills$/))
    data = { assignedSkillIds: ['skill-1'], globalSkillIds: [] };
  else if (path === '/api/mod-management')
    data = { mods, sources: modSources, restartRequired: false };
  else if (path === '/api/mod-management/source-refresh')
    data = { sourceRefresh: { enabled: false, intervalMs: 3600000, staleMs: 86400000 } };
  else if (path.startsWith('/api/mod-management/secret-references'))
    data = {
      references: Array.from({ length: 3 }, (_, i) => ({
        reference: `{{gss:synthetic-credential-${i + 1}}}`,
        label: `Synthetic repository credential ${i + 1}`,
        type: 'token',
        username: 'synthetic-user',
        service: 'Fixture Git',
        url: 'https://example.invalid',
      })),
    };
  else if (path === '/api/health')
    data = {
      ok: true,
      runtime: 'fixture',
      ui: { authMode: 'none' },
      model: { configured: false },
      traces: {},
    };
  else if (path === '/api/metrics')
    data = {
      ok: true,
      process: {
        cpu: { percent: 1 },
        uptimeSeconds: 900,
        rssBytes: 1000000,
        heapUsedBytes: 400000,
        heapTotalBytes: 1000000,
        externalBytes: 0,
      },
      load: { oneMinute: 0.1, fiveMinutes: 0.1, fifteenMinutes: 0.1 },
      filesystem: { usedBytes: 1000000, totalBytes: 100000000, availableBytes: 99000000 },
    };
  else if (path.match(/\/api\/agents\/[^/]+$/))
    data = { agent: agents.find((agent) => agent.id === decodeURIComponent(path.split('/')[3])) };
  else if (path.endsWith('/minion-settings')) data = { ok: true, maxDepth: 1 };
  else if (path.endsWith('/minion-model-selection')) data = { ok: true, selection: null };
  else if (path === '/api/settings/curator')
    data = { ok: true, configured: false, selection: null, available: false };
  else if (path.startsWith('/api/operator/reference-image/content?')) {
    const bytes = Uint8Array.from(atob(operatorReferenceContent.split(',')[1]), (c) =>
      c.charCodeAt(0),
    );
    return new Response(bytes, {
      headers: { 'Content-Type': operatorReferenceImage?.mimeType ?? 'image/png' },
    });
  } else if (path === '/api/operator/reference-image') {
    if (method === 'DELETE') operatorReferenceImage = null;
    if (method === 'PUT') {
      operatorReferenceContent = body.content;
      operatorReferenceImage = {
        id: 'fixture-operator-reference',
        attachmentId: 'fixture-upload-reference',
        contentUrl: '/api/operator/reference-image/content?revision=upload',
        mimeType: 'image/png',
        fileName: body.fileName,
        sizeBytes: atob(body.content.split(',')[1]).length,
        updatedAt: '2026-11-02T01:00:00Z',
      };
    }
    data = { ok: true, referenceImage: operatorReferenceImage };
  } else if (path.endsWith('/reference-image'))
    data = { ok: true, agentId: decodeURIComponent(path.split('/')[3]), referenceImage: null };
  else if (path === '/api/settings/retention')
    data = {
      ok: true,
      policy: {
        version: 1,
        enabled: false,
        traceMaxAgeDays: null,
        traceMaxBytes: null,
        intervalMinutes: 1440,
      },
      state: {},
      plan: {
        ok: true,
        dryRun: true,
        retention: {},
        counts: { deleteTraces: 0, deleteTraceBytes: 0, traceBytes: 0 },
      },
    };
  else if (path === '/api/settings/brain-embeddings')
    data = {
      enabled: false,
      connectionId: null,
      model: null,
      generation: 'fixture',
      total: '0',
      indexed: '0',
      pending: '0',
      failed: '0',
      storage: '0',
      lastError: null,
    };
  else if (path === '/api/settings/brain-memory') data = { promoteDreamsToMemory: true };
  else if (path === '/api/export/catalog')
    data = {
      categories: [
        ['agents', 'Agents', false],
        ['skills', 'Skills', false],
        ['scheduled-jobs', 'Scheduled jobs', false],
        ['settings', 'Settings', false],
        ['model-connections', 'Model connections', true],
        ['mcp-connections', 'MCP connections', true],
        ['ui-auth', 'UI authentication', true],
        ['task-board', 'Task board', false],
      ].map(([id, label, containsSecrets]) => ({
        id,
        label,
        description: 'Synthetic portable ' + String(label).toLowerCase(),
        containsSecrets,
      })),
      passwordMinLength: 12,
    };
  else if (path === '/api/settings/opentelemetry')
    data = {
      settings: { enabled: false, destinations: telemetryDestinations },
      effective: { enabled: false, destinations: [], source: 'database' },
      providers: [
        {
          id: 'custom',
          label: 'Custom',
          protocols: ['http/protobuf'],
          defaultProtocol: 'http/protobuf',
          traces: true,
          metrics: true,
          defaultTemporality: 'cumulative',
        },
      ],
    };
  else if (path === '/api/settings/mcp-connections') data = { connections: mcpConnections };
  else if (path.endsWith('/mcp-tools')) {
    const agentId = decodeURIComponent(path.split('/')[3]);
    if (method === 'PUT') grantsByAgent[agentId] = body.tools;
    data = { ok: true, agentId, tools: grantsByAgent[agentId] ?? [] };
  } else if (path === '/api/settings/api-tokens')
    data = { ok: true, tokens: apiTokens, supportedScopes: ['diagnostics:read'] };
  else if (path === '/api/settings/execution-boundaries')
    data = {
      boundaries: { version: 1, hardBlocks: boundaries },
      status: { enabled: true, hardBlockCount: 6, enabledHardBlockCount: 6 },
    };
  else if (path.startsWith('/api/scheduled-jobs')) {
    const url = new URL(path, 'https://fixture.invalid'),
      id = url.pathname.split('/')[3],
      job = scheduledJobs.find((j) => j.id === id);
    if (method === 'PATCH' && job) {
      Object.assign(job, body);
      data = { ok: true, job };
    } else if (path.endsWith('/trigger'))
      data = {
        ok: true,
        run: {
          status: 'completed',
          sessionId: `${job?.agentId}-fixture-session`,
          agentId: job?.agentId,
          runId: 'fixture-trigger',
        },
      };
    else
      data = { jobs: scheduledJobs.filter((j) => j.agentId === url.searchParams.get('agentId')) };
  } else if (path === '/api/task-board/tasks') data = { tasks: [] };
  else if (path === '/api/task-board/projects') data = { projects: [] };
  else if (path === '/api/events/watches') {
    if (method === 'POST') {
      const watch = { ...body, id: body.id ?? 'fixture-new-watch' };
      workflowWatches = [watch, ...workflowWatches.filter((w) => w.id !== watch.id)];
      data = { ok: true, watch };
    } else data = { ok: true, watches: workflowWatches };
  } else if (path.startsWith('/api/events/recent')) data = { ok: true, events: [] };
  else if (path.startsWith('/api/sessions')) data = { sessions: [] };
  else if (path === '/api/events/settings')
    data = {
      ok: true,
      settings: {
        deliveryUrl: '',
        webhookPath: '/api/events/github',
        secretConfigured: false,
        storedSecretConfigured: false,
        secretSource: 'none',
        environmentOverride: false,
        ready: false,
        readiness: 'secret_missing',
      },
    };
  else if (path.endsWith('/dream-settings')) {
    const id = path.split('/')[3];
    const settings = (dreamSettingsByAgent[id] ??= {
      enabled: false,
      quietDayDreams: true,
      promoteToMemory: true,
      cron: '0 3 * * *',
      timezone: null,
      effectiveTimezone: 'America/Chicago',
      prompt:
        'Synthetic dream prompt: review retained evidence, preserve uncertainty, and summarize useful continuity.',
      defaultMemoryPrompt: 'Synthetic memory prompt: promote only validated durable facts.',
      memoryEmphasis: 50,
      memoryPromptOverride: null,
      modelConnectionId: null,
      model: null,
    });
    if (method === 'PUT') Object.assign(settings, body);
    data = { settings, effectiveModel: null };
  } else {
    data = {};
  }

  return Response.json(data);
}) as typeof fetch;
Object.assign(window, {
  fixtureEvidence: { requests, errors },
  fixtureSetTab: null,
  fixtureQueueDiscovery: (outcomes: DiscoveryOutcome[]) => {
    discoveryOutcomes = [...outcomes];
  },
  fixtureReleaseDiscovery: (outcome: DiscoveryOutcome) => {
    if (!releaseDiscovery) throw new Error('No pending synthetic discovery');
    const release = releaseDiscovery;
    releaseDiscovery = undefined;
    release(outcome);
  },
  fixtureFailNextModelSave: () => {
    failNextModelSave = true;
  },
});
function Fixture() {
  const [tab, setTab] = useState<SettingsTab>('connections');
  const [agentCount, setAgentCount] = useState(agents.length);
  const [agentNames, setAgentNames] = useState<Record<string, string>>({});
  const fixtureAgents = useMemo(
    () =>
      agents
        .slice(0, agentCount)
        .map((agent) => ({ ...agent, name: agentNames[agent.id] ?? agent.name })),
    [agentCount, agentNames],
  );
  const [savedProviders, setProviders] = useState(providers);
  const [nav, setNav] = useState<HTMLDivElement | null>(null);
  const [theme, setTheme] = useState<Theme>('smatchet');
  const [prefs, setPrefs] = useState<any>({ view: 'regular', order: [] });
  Object.assign(window, {
    fixtureSetTab: setTab,
    fixtureSetAgentCount: (count: number) => {
      if (!Number.isInteger(count) || count < 1 || count > agents.length)
        throw new Error('Synthetic agent count must be between 1 and 17');
      setAgentCount(count);
    },
    fixtureSetAgentNames: (names: Record<string, string>) => {
      if (
        Object.entries(names).some(
          ([id, name]) =>
            !agents.some((agent) => agent.id === id) || typeof name !== 'string' || !name.trim(),
        )
      )
        throw new Error('Synthetic agent names must identify existing agents');
      setAgentNames({ ...names });
    },
    fixtureExpandProviders: () => {
      let count = providers.filter((p) => !p.pool).length;
      while (count < 8) {
        count++;
        providers.push({
          id: `scale-${count}`,
          provider: `Synthetic provider ${count} regional research connection`,
          apiType: 'openai-responses',
          url: `https://synthetic-scale-${count}.invalid/v1`,
          apiKey: '',
          apiKeyConfigured: true,
          models: models(`scale-${count}`)
            .filter((m) => m.selected)
            .map((m) => m.id),
          connectionModels: models(`scale-${count}`),
        } as SavedProvider);
      }
      setProviders([...providers]);
    },
  });
  const panel = () => {};
  return (
    <main className="cockpit settings-mode settings-top-navigation" data-theme={theme}>
      <div className="app-navigation-stack">
        <header className="app-header">
          <nav className="page-tabs" aria-label="Primary navigation">
            {['Chat', 'Tasks', 'Archive', 'Brains', 'Forge', 'Settings'].map((label) => (
              <button
                type="button"
                className={label === 'Settings' ? 'active' : ''}
                aria-current={label === 'Settings' ? 'page' : undefined}
                key={label}
              >
                {label}
              </button>
            ))}
          </nav>
        </header>
        <div ref={setNav} className="settings-navigation-card" />
      </div>
      <section className="workspace settings-workspace">
        <div className="workspace-watermark" aria-hidden="true">
          <img src="/burrow-logo.png" alt="" />
        </div>
        <Settings
          navigationTarget={nav}
          tab={tab}
          setTab={setTab}
          agents={fixtureAgents}
          selected={agents[0]}
          savedProviders={savedProviders}
          onModelConnectionsChanged={async () => setProviders([...providers])}
          onAgentsChanged={async () => {}}
          onOperatorProfileChanged={() => {}}
          onFirstRunComplete={() => {}}
          leftTopPanel={'agents' as PanelId}
          setLeftTopPanel={panel}
          leftBottomPanel={'workspace' as PanelId}
          setLeftBottomPanel={panel}
          rightTopPanel={'accounts' as PanelId}
          setRightTopPanel={panel}
          rightBottomPanel={'workspace' as PanelId}
          setRightBottomPanel={panel}
          leftSinglePanel={'agents' as PanelId}
          setLeftSinglePanel={panel}
          rightSinglePanel={'workspace' as PanelId}
          setRightSinglePanel={panel}
          leftRailLayout="single"
          setLeftRailLayout={panel}
          rightRailLayout="single"
          setRightRailLayout={panel}
          theme={theme}
          setTheme={(value) => {
            setTheme(value);
            document.documentElement.dataset.theme = value;
          }}
          agentRailPreferences={prefs}
          setAgentRailPreferences={setPrefs}
        />
      </section>
      <footer className="status-bar">
        <span className="ok">
          <i className="dot" />
          Synthetic fixture
        </span>
        <span className="status-right">Burrow-Fidgit · isolated settings QA</span>
      </footer>
    </main>
  );
}
export const fixtureRoot = createRoot(document.getElementById('root')!);
fixtureRoot.render(
  <ConfirmProvider>
    <UnsavedChangesProvider>
      <Fixture />
    </UnsavedChangesProvider>
  </ConfirmProvider>,
);
