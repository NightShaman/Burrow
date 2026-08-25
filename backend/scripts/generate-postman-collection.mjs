#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const scriptArgs = process.argv.slice(2);
const checkOnly = scriptArgs.includes('--check');
const outputPath = scriptArgs.find((arg) => arg !== '--check') || path.resolve('docs/burrow-api.postman_collection.json');

function raw(pathname, query = []) {
  const url = { raw: `{{baseUrl}}${pathname}${query.length ? `?${query.map(([k, v]) => `${k}=${v}`).join('&')}` : ''}`, host: ['{{baseUrl}}'], path: pathname.replace(/^\//, '').split('/') };
  if (query.length) url.query = query.map(([key, value, description]) => ({ key, value, description })).filter(Boolean);
  return url;
}
function body(obj) { return { mode: 'raw', raw: JSON.stringify(obj, null, 2), options: { raw: { language: 'json' } } }; }
function req(name, method, pathname, { query = [], body: requestBody = null, description = '' } = {}) {
  const request = { method, header: [{ key: 'Accept', value: 'application/json' }] , url: raw(pathname, query), description };
  if (requestBody !== null) {
    request.header.push({ key: 'Content-Type', value: 'application/json' });
    request.body = body(requestBody);
  }
  return { name, request };
}
function folder(name, item, description = '') { return { name, description, item }; }

const collection = {
  info: {
    name: 'Burrow API',
    description: [
      'Generated from the live Burrow router (`scripts/burrow-ui.mjs`) on 2026-08-09.',
      '',
      'Auth: default local installs may have auth disabled. Current product auth modes are none, trusted-proxy, and basic; settings are managed by GET/PUT /api/settings/ui-auth. Environment variables remain an operator override path.',
      '',
      'Most responses are JSON envelopes with `ok: true|false`. Mutating examples use safe placeholder IDs; adjust before sending.',
    ].join('\n'),
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    _postman_id: 'b0f0b5af-a7dd-4c36-9b75-burrow-api',
  },
  variable: [
    { key: 'baseUrl', value: 'http://127.0.0.1:42817' },
    { key: 'agentId', value: 'hatchet' },
    { key: 'sessionId', value: 'default' },
    { key: 'archiveSessionId', value: 'default.reset.2026-08-15T20-05-44-730Z' },
    { key: 'runId', value: 'manual-run' },
    { key: 'connectionId', value: 'model-connection-id' },
    { key: 'mcpConnectionId', value: 'mcp-connection-id' },
    { key: 'loginId', value: 'claude-login-id' },
    { key: 'taskId', value: 'task-id' },
    { key: 'projectId', value: 'project-id' },
    { key: 'jobId', value: 'scheduled-job-id' },
    { key: 'jobRunId', value: 'scheduled-run-id' },
    { key: 'channelId', value: 'group-channel-id' },
    { key: 'groupRunId', value: 'group-run-id' },
    { key: 'workItemId', value: 'work-item-id' },
    { key: 'traceRunId', value: 'trace-run-id' },
  ],
  item: [
    folder('Status / Runtime', [
      req('Health', 'GET', '/api/health', { query: [['agentId', '{{agentId}}', 'Optional selected agent']] }),
      req('Health alias', 'GET', '/health'),
      req('Status', 'GET', '/api/status', { query: [['agentId', '{{agentId}}']] }),
      req('Metrics', 'GET', '/api/metrics'),
      req('Codex-LB accounts', 'GET', '/api/codex-lb/accounts'),
      req('Agent status', 'GET', '/api/agent-status', { query: [['agentId', '{{agentId}}'], ['sessionId', '{{sessionId}}']] }),
      req('Active chat runs', 'GET', '/api/chat/runs/active', { query: [['agentId', '{{agentId}}'], ['sessionId', '{{sessionId}}']] }),
    ]),
    folder('Agents', [
      req('List agents', 'GET', '/api/agents', { query: [['includeDisabled', 'true']] }),
      req('Create agent', 'POST', '/api/agents', { body: { id: 'new-agent', name: 'New Agent', modelProfile: 'default' } }),
      req('Update agent', 'PATCH', '/api/agents/{{agentId}}', { body: { name: 'Hatchet', enabled: true, contextConfig: { version: 1 } } }),
      req('Delete agent', 'DELETE', '/api/agents/{{agentId}}'),
      req('Get profile documents', 'GET', '/api/agents/{{agentId}}/profile-documents'),
      req('Replace profile documents', 'PUT', '/api/agents/{{agentId}}/profile-documents', { body: { documents: [
        { kind: 'SOUL', markdown: '# SOUL\n' }, { kind: 'RULES', markdown: '# RULES\n' }, { kind: 'ORIENTATION', markdown: '# ORIENTATION\n' }, { kind: 'TOOLS', markdown: '# TOOLS\n' },
      ] } }),
      req('Get agent model selection', 'GET', '/api/agents/{{agentId}}/model-selection'),
      req('Set agent model selection', 'PUT', '/api/agents/{{agentId}}/model-selection', { body: { modelConnectionId: '{{connectionId}}', model: 'gpt-5.4', reasoningEffort: 'medium', temperature: 0.4 } }),
      req('Get agent MCP tools', 'GET', '/api/agents/{{agentId}}/mcp-tools'),
      req('Set agent MCP tools', 'PUT', '/api/agents/{{agentId}}/mcp-tools', { body: { tools: [{ connectionId: '{{mcpConnectionId}}', name: 'tool_name', enabled: true }] } }),
    ]),
    folder('Dreams', [
      req('Get dream settings', 'GET', '/api/agents/{{agentId}}/dream-settings'),
      req('Update dream settings', 'PUT', '/api/agents/{{agentId}}/dream-settings', { body: { enabled: true, timezone: 'America/Chicago', schedule: '0 4 * * *', prompt: 'Write one short dream diary entry.' } }),
      req('List dream diary', 'GET', '/api/agents/{{agentId}}/dream-diary', { query: [['date', ''], ['limit', '30'], ['phase', 'rem'], ['format', 'narrative']] }),
      req('Append dream diary entry', 'POST', '/api/agents/{{agentId}}/dream-diary', { body: { date: '2026-08-09', phase: 'REM', narrative: 'A short operator-facing dream entry.', sourceRefs: [] } }),
      req('Consolidate DreamMemory', 'POST', '/api/agents/{{agentId}}/dream-memory/consolidate', { body: { limit: 20 } }),
      req('Recent dream cycles', 'GET', '/api/agents/{{agentId}}/dream-cycle', { query: [['limit', '10']] }),
      req('Run dream cycle', 'POST', '/api/agents/{{agentId}}/dream-cycle', { body: { phase: 'manual' } }),
    ]),
    folder('Settings / Identities', [
      req('Get identities', 'GET', '/api/settings/identities'),
      req('Update identities', 'PUT', '/api/settings/identities', { body: { operator: { name: 'Operator', avatar: '' }, agents: [] } }),
      req('Get curator settings', 'GET', '/api/settings/curator'),
      req('Update curator settings', 'PUT', '/api/settings/curator', { body: { kind: 'external', connectionId: '{{connectionId}}', model: 'gpt-5.4-mini', temperature: 0.2 } }),
      req('Get Tiddle rolling-continuity status', 'GET', '/api/settings/tiddle', { query: [['agentId', '{{agentId}}']] }),
      req('List Tiddle warm cards', 'GET', '/api/tiddle/cards', { query: [['agentId', '{{agentId}}'], ['scope', ''], ['limit', '100']] }),
      req('Read Tiddle Signal history', 'GET', '/api/tiddle/history', { query: [['agentId', '{{agentId}}'], ['cardId', ''], ['since', ''], ['limit', '100']] }),
    ]),
    folder('Settings / Model Connections', [
      req('List model connections', 'GET', '/api/settings/model-connections'),
      req('Discover models', 'POST', '/api/settings/model-connections/discover', { body: { id: '{{connectionId}}', provider: 'Anthropic', apiType: 'anthropic-messages', baseUrl: 'https://api.anthropic.com' } }),
      req('Save model connection', 'POST', '/api/settings/model-connections', { body: { provider: 'Anthropic Claude Code', apiType: 'anthropic-messages', baseUrl: 'https://api.anthropic.com', auth: { type: 'oauth', token: 'access-token', refreshToken: 'refresh-token', expiresAt: 1800000000000 }, models: [{ id: 'claude-sonnet-4-6', selected: true }] } }),
      req('Delete model connection', 'DELETE', '/api/settings/model-connections/{{connectionId}}'),
      req('Detect Claude CLI credential', 'GET', '/api/settings/model-connections/claude-cli-credential'),
      req('Import Claude CLI credential', 'POST', '/api/settings/model-connections/import-claude-cli-credential', { body: { connectionId: '{{connectionId}}' } }),
      req('Start OpenAI OAuth login', 'POST', '/api/settings/model-connections/openai-oauth/start', { body: { connectionId: '{{connectionId}}' } }),
      req('Get OpenAI OAuth login status', 'GET', '/api/settings/model-connections/openai-oauth/{{loginId}}'),
      req('Submit OpenAI OAuth code', 'POST', '/api/settings/model-connections/openai-oauth/{{loginId}}/submit-code', { body: { redirectUrl: 'paste-callback-url-here' } }),
      req('Cancel OpenAI OAuth login', 'POST', '/api/settings/model-connections/openai-oauth/{{loginId}}/cancel', { body: {} }),
      req('Start Claude Code login', 'POST', '/api/settings/model-connections/claude-code-login/start', { body: {} }),
      req('Get Claude Code login status', 'GET', '/api/settings/model-connections/claude-code-login/{{loginId}}'),
      req('Submit Claude Code login code', 'POST', '/api/settings/model-connections/claude-code-login/{{loginId}}/submit-code', { body: { code: 'paste-callback-code-here' } }),
      req('Cancel Claude Code login', 'POST', '/api/settings/model-connections/claude-code-login/{{loginId}}/cancel', { body: {} }),
      req('Import Claude Code login credential', 'POST', '/api/settings/model-connections/claude-code-login/{{loginId}}/import', { body: { connectionId: '{{connectionId}}' } }),
    ]),
    folder('Settings / MCP Connections', [
      req('List MCP connections', 'GET', '/api/settings/mcp-connections'),
      req('Save MCP connection', 'POST', '/api/settings/mcp-connections', { body: { name: 'Memory API', transport: 'http', baseUrl: 'http://127.0.0.1:8100/mcp', lifecycle: 'ephemeral', apiKey: '' } }),
      req('Discover MCP tools', 'POST', '/api/settings/mcp-connections/discover', { body: { connectionId: '{{mcpConnectionId}}' } }),
      req('Delete MCP connection', 'DELETE', '/api/settings/mcp-connections/{{mcpConnectionId}}'),
    ]),
    folder('Chat', [
      req('Send chat', 'POST', '/api/chat', { body: { agentId: '{{agentId}}', sessionId: '{{sessionId}}', message: 'Hello from Postman', reasoningEffort: 'medium', temperature: 0.4 } }),
      req('Send chat with image attachment', 'POST', '/api/chat', { body: { agentId: '{{agentId}}', sessionId: '{{sessionId}}', message: 'Describe this image.', attachments: [{ name: 'image.png', type: 'image/png', size: 123, encoding: 'data-url', content: 'data:image/png;base64,REPLACE_ME' }] } }),
      req('Send chat with text attachment', 'POST', '/api/chat', { body: { agentId: '{{agentId}}', sessionId: '{{sessionId}}', message: 'Summarize the attached notes.', attachments: [{ name: 'notes.txt', type: 'text/plain', size: 44, encoding: 'utf8', content: 'A short inline note for Burrow.' }] } }),
      req('Cancel chat run', 'POST', '/api/chat/{{runId}}/cancel', { body: { agentId: '{{agentId}}', reason: 'operator_cancelled' } }),
    ]),
    folder('Workspace Files', [
      req('List workspace files', 'GET', '/api/workspace/files', { query: [['agentId', '{{agentId}}'], ['scope', 'agent']] }),
      req('Read workspace file', 'GET', '/api/workspace/file', { query: [['agentId', '{{agentId}}'], ['scope', 'agent'], ['path', 'README.md']] }),
      req('Write workspace file', 'POST', '/api/workspace/file', { body: { agentId: '{{agentId}}', scope: 'agent', path: 'README.md', content: '# Updated\n' } }),
    ]),
    folder('Session Context / Search', [
      req('Inspect session context', 'GET', '/api/session/context', { query: [['agentId', '{{agentId}}'], ['sessionId', '{{sessionId}}']] }),
      req('Session context status', 'GET', '/api/session/context-status', { query: [['agentId', '{{agentId}}'], ['sessionId', '{{sessionId}}']] }),
      req('Context alias', 'GET', '/api/context', { query: [['agentId', '{{agentId}}'], ['sessionId', '{{sessionId}}']] }),
      req('Search session evidence', 'GET', '/api/session/search', { query: [['scope', 'session'], ['agentId', '{{agentId}}'], ['sessionId', '{{sessionId}}'], ['q', 'search terms'], ['role', 'any'], ['limit', '50']] }),
      req('Search all HC evidence', 'GET', '/api/session/search', { query: [['scope', 'burrow'], ['q', 'search terms'], ['role', 'any'], ['limit', '50'], ['archived', 'true']] }),
    ]),
    folder('Sessions', [
      req('List archive Dreams', 'GET', '/api/archive/dreams', { query: [['agentId', '{{agentId}}'], ['limit', '200']] }),
      req('Read archive Dream', 'GET', '/api/archive/dreams/{{agentId}}/{{dreamEntryId}}'),
      req('List archive continuity cards', 'GET', '/api/archive/continuity/cards', { query: [['agentId', '{{agentId}}'], ['scope', ''], ['limit', '200']] }),
      req('Read archive continuity card', 'GET', '/api/archive/continuity/cards/{{agentId}}/{{continuityCardId}}', { query: [['limit', '200']] }),
      req('List archived sessions and reset snapshots', 'GET', '/api/archive/sessions', { query: [['archived', 'true'], ['q', ''], ['limit', '200']] }),
      req('Read archived session or reset snapshot', 'GET', '/api/archive/sessions/{{agentId}}/{{archiveSessionId}}'),
      req('List sessions', 'GET', '/api/sessions', { query: [['agentId', '{{agentId}}'], ['archived', 'false'], ['q', '']] }),
      req('Get session', 'GET', '/api/sessions/{{sessionId}}', { query: [['agentId', '{{agentId}}']] }),
      req('Export canonical session', 'GET', '/api/sessions/{{sessionId}}/export', { query: [['agentId', '{{agentId}}']] }),
      req('Reset session', 'POST', '/api/sessions/{{sessionId}}/reset', { query: [['agentId', '{{agentId}}']], body: {} }),
      req('Rename session', 'POST', '/api/sessions/{{sessionId}}/rename', { query: [['agentId', '{{agentId}}']], body: { targetSessionId: 'renamed-session' } }),
      req('Archive session', 'POST', '/api/sessions/{{sessionId}}/archive', { query: [['agentId', '{{agentId}}']], body: { archived: true } }),
      req('Unarchive session', 'POST', '/api/sessions/{{sessionId}}/unarchive', { query: [['agentId', '{{agentId}}']], body: {} }),
      req('Fork session', 'POST', '/api/sessions/{{sessionId}}/fork', { query: [['agentId', '{{agentId}}']], body: { targetSessionId: 'forked-session' } }),
      req('List session authority', 'GET', '/api/sessions/{{sessionId}}/authority', { query: [['agentId', '{{agentId}}'], ['limit', '20']] }),
      req('Latest session authority', 'GET', '/api/sessions/{{sessionId}}/authority/latest', { query: [['agentId', '{{agentId}}']] }),
    ]),
    folder('Traces', [
      req('List traces', 'GET', '/api/traces', { query: [['agentId', '{{agentId}}'], ['sessionId', '{{sessionId}}']] }),
      req('Get trace summary', 'GET', '/api/traces/{{traceRunId}}', { query: [['agentId', '{{agentId}}'], ['sessionId', '{{sessionId}}'], ['output', 'false']] }),
      req('Get trace authority', 'GET', '/api/traces/{{traceRunId}}/authority', { query: [['agentId', '{{agentId}}'], ['sessionId', '{{sessionId}}']] }),
    ]),
    folder('Continuity / Memory Review', [
      req('Get continuity scope', 'GET', '/api/session/continuity-scope', { query: [['agentId', '{{agentId}}'], ['sessionId', '{{sessionId}}']] }),
      req('Set continuity scope', 'PUT', '/api/session/continuity-scope', { body: { agentId: '{{agentId}}', sessionId: '{{sessionId}}', continuityScope: 'project:example' } }),
      req('Clear continuity scope', 'DELETE', '/api/session/continuity-scope', { query: [['agentId', '{{agentId}}'], ['sessionId', '{{sessionId}}']] }),
      req('Read session handoff', 'GET', '/api/session/handoff', { query: [['agentId', '{{agentId}}'], ['sessionId', '{{sessionId}}']] }),
      req('Write session handoff', 'POST', '/api/session/handoff', { body: { agentId: '{{agentId}}', sessionId: '{{sessionId}}', summary: 'Short handoff.' } }),
      req('Write handoff candidate', 'POST', '/api/session/handoff-candidate', { body: { agentId: '{{agentId}}', sessionId: '{{sessionId}}', summary: 'Candidate handoff.' } }),
      req('List Brain promotion candidates', 'GET', '/api/memory/brain-promotion-candidates', { query: [['agentId', '{{agentId}}'], ['limit', '50']] }),
      req('Update Brain promotion candidate', 'PATCH', '/api/memory/brain-promotion-candidates', { body: { id: 'candidate-id', status: 'dismissed' } }),
    ]),
    folder('Retention', [
      req('Retention dry run', 'GET', '/api/retention'),
      req('Run retention cleanup', 'POST', '/api/retention/cleanup', { body: { confirm: false } }),
    ]),
    folder('Scheduled Jobs', [
      req('List scheduled jobs', 'GET', '/api/scheduled-jobs', { query: [['agentId', '{{agentId}}'], ['enabled', 'true']] }),
      req('Create scheduled job', 'POST', '/api/scheduled-jobs', { body: { agentId: '{{agentId}}', name: 'Daily check', prompt: 'Run a daily check.', schedule: '0 8 * * *', timezone: 'America/Chicago', enabled: false } }),
      req('Get scheduled job', 'GET', '/api/scheduled-jobs/{{jobId}}'),
      req('Update scheduled job', 'PATCH', '/api/scheduled-jobs/{{jobId}}', { body: { enabled: false, name: 'Daily check updated' } }),
      req('Delete scheduled job', 'DELETE', '/api/scheduled-jobs/{{jobId}}'),
      req('List scheduled job runs', 'GET', '/api/scheduled-jobs/{{jobId}}/runs', { query: [['limit', '20']] }),
      req('Trigger scheduled job', 'POST', '/api/scheduled-jobs/{{jobId}}/trigger', { body: {} }),
      req('Cancel scheduled job run', 'POST', '/api/scheduled-jobs/{{jobId}}/runs/{{jobRunId}}/cancel', { body: { reason: 'operator_cancelled' } }),
    ]),
    folder('Task Board', [
      req('List task statuses', 'GET', '/api/task-board/statuses'),
      req('List task priorities', 'GET', '/api/task-board/priorities'),
      req('List projects', 'GET', '/api/task-board/projects'),
      req('Create project', 'POST', '/api/task-board/projects', { body: { name: 'Project', description: 'Tracked work' } }),
      req('Update project', 'PATCH', '/api/task-board/projects/{{projectId}}', { body: { name: 'Project updated' } }),
      req('Delete project', 'DELETE', '/api/task-board/projects/{{projectId}}'),
      req('List tasks', 'GET', '/api/task-board/tasks', { query: [['projectId', '{{projectId}}'], ['status', 'todo'], ['priority', 'normal'], ['assignedAgentId', '{{agentId}}']] }),
      req('Create task', 'POST', '/api/task-board/tasks', { body: { projectId: '{{projectId}}', title: 'Task title', description: 'Task details', priority: 'normal', status: 'todo', assignedAgentId: '{{agentId}}' } }),
      req('Get task', 'GET', '/api/task-board/tasks/{{taskId}}'),
      req('Update task', 'PATCH', '/api/task-board/tasks/{{taskId}}', { body: { status: 'in_progress' } }),
      req('Delete task', 'DELETE', '/api/task-board/tasks/{{taskId}}'),
      req('Execute task', 'POST', '/api/task-board/tasks/{{taskId}}/execute', { body: {} }),
    ]),
    folder('Legacy Work Items / Workbench', [
      req('List work items', 'GET', '/api/tasks', { query: [['agentId', '{{agentId}}']] }),
      req('Create work item', 'POST', '/api/tasks', { body: { agentId: '{{agentId}}', title: 'Work item', description: 'Do work', workspaceRoot: '/path/to/workspace' } }),
      req('Get work item', 'GET', '/api/tasks/{{workItemId}}', { query: [['agentId', '{{agentId}}']] }),
      req('Run work item step', 'POST', '/api/tasks/{{workItemId}}/step', { body: { agentId: '{{agentId}}', step: 'inspect' } }),
      req('Continue work item', 'POST', '/api/tasks/{{workItemId}}/continue', { body: { agentId: '{{agentId}}', message: 'Continue.' } }),
      req('Archive work item', 'POST', '/api/tasks/{{workItemId}}/archive', { body: { agentId: '{{agentId}}' } }),
      req('Plan workbench turn', 'POST', '/api/workbench', { body: { agentId: '{{agentId}}', message: 'Plan this change.', workspaceRoot: '/path/to/workspace' } }),
      req('Run workbench step', 'POST', '/api/workbench/run', { body: { agentId: '{{agentId}}', step: 'inspect', message: 'Inspect.' } }),
    ]),
    folder('Group Channels', [
      req('List group channels', 'GET', '/api/group-channels'),
      req('Create group channel', 'POST', '/api/group-channels', { body: { name: 'Room', participantAgentIds: ['hatchet', 'smatchet'] } }),
      req('Get group channel', 'GET', '/api/group-channels/{{channelId}}'),
      req('Post group message', 'POST', '/api/group-channels/{{channelId}}/messages', { body: { message: 'Hello group', attachments: [] } }),
      req('Cancel group run', 'POST', '/api/group-channels/{{channelId}}/runs/{{groupRunId}}/cancel', { body: { reason: 'operator_cancelled' } }),
    ]),
  ],
};

const generated = `${JSON.stringify(collection, null, 2)}\n`;
if (checkOnly) {
  const current = await readFile(outputPath, 'utf8').catch((error) => { if (error?.code === 'ENOENT') return null; throw error; });
  if (current !== generated) {
    console.error(`Postman collection is stale: ${outputPath}`);
    process.exitCode = 1;
  } else {
    console.log(`Postman collection is current: ${outputPath}`);
  }
} else {
  await writeFile(outputPath, generated, 'utf8');
  console.log(outputPath);
}
