import { expect, it } from 'vitest';
import type { ActiveChatRunsResponse } from '../../app/api';
import { projectChatActivity } from './chatActivityProjection';
const selection = { agentId: 'a', sessionId: 'parent', isChildSession: false, hadRuns: false, now: Date.parse('2026-10-15T00:02:00Z') };
it('is deterministic without mutating the response and keeps parent/child identity separate', () => {
  const response = { ok: true, runs: [{ status: 'running', runId: 'r', agentId: 'a', sessionId: 'parent', steeringReady: true, answerText: ' partial ', progress: [] }], subagents: [
    { id: 'c', agentId: 'a', runId: 'cr', parentRunId: 'r', parentSessionId: 'parent', sessionId: 'child', final: false, activity: { startedAt: '2026-10-15T00:00:00Z', tool: 'shell_exec' } },
    { id: 'foreign', agentId: 'b', parentSessionId: 'parent', final: false },
  ] } as ActiveChatRunsResponse;
  const before = JSON.stringify(response);
  const first = projectChatActivity(response, selection);
  expect(projectChatActivity(response, selection)).toEqual(first);
  expect(JSON.stringify(response)).toBe(before);
  expect(first.runtimeRun).toMatchObject({ runId: 'r', agentId: 'a', sessionId: 'parent', steeringReady: true, answerText: ' partial ' });
  expect(first.childActivities).toHaveLength(1);
  expect(first.childActivities[0].summary).toContain('elapsed 2m');
  expect(projectChatActivity({ ...response, runs: [] }, selection).runtimeRun).toBeNull();
  expect(projectChatActivity({ ...response, runs: [] }, { ...selection, sessionId: 'child', isChildSession: true }).runtimeRun?.runId).toBe('cr');
});
it('rejects foreign run/session progress for stage, thought and tool projection and never exposes MCP payloads', () => {
  const response = { ok: true, runs: [{ status: 'running', runId: 'r', agentId: 'a', sessionId: 'parent', progress: [
    { type: 'assistant.thought', runId: 'foreign', data: { delta: 'intruder' } },
    { type: 'tool.started', sessionId: 'foreign', data: { tool: 'bad', activityId: 'foreign' } },
    { type: 'model.dispatched', runId: 'r', data: { modelCall: 1 } },
    { type: 'tool.completed', runId: 'r', data: { tool: 'mcp_call', mcpToolName: 'safe_name', activityId: 'good', output: 'secret', command: 'secret' } },
  ] }] } as ActiveChatRunsResponse;
  const { runtimeRun } = projectChatActivity(response, selection);
  expect(runtimeRun?.progress).toEqual([]);
  expect(runtimeRun?.toolActivity?.items).toEqual([{ id: 'good', label: 'MCP tool', status: 'ok' }]);
  expect(JSON.stringify(runtimeRun)).not.toContain('secret');
});
it('requests one terminal refresh after activity disappears, and keeps child terminal writes refreshable', () => {
  expect(projectChatActivity({ ok: true, runs: [] }, selection).shouldRefresh).toBe(false);
  expect(projectChatActivity({ ok: true, runs: [] }, { ...selection, hadRuns: true })).toMatchObject({ shouldRefresh: true, hadRuns: false });
  expect(projectChatActivity({ ok: true, runs: [] }, { ...selection, isChildSession: true }).shouldRefresh).toBe(true);
});

it.each(['cancelled', 'completed', 'failed', 'superseded'])('never projects a %s summary as live, including child fallback and A2A', (status) => {
  const terminal = { runId: 'old', agentId: 'a', sessionId: 'parent', status, source: 'a2a', a2a: { parentAgentId: 'b' } };
  const response = { ok: true, runs: [terminal], subagents: [{ id: 'child', runId: 'old', agentId: 'a', sessionId: 'parent', final: false }] };
  expect(projectChatActivity(response, { ...selection, isChildSession: true })).toMatchObject({ runtimeRun: null, a2aActivities: [], shouldRefresh: true });
  for (const liveStatus of ['running', 'cancelling']) {
    expect(projectChatActivity({ ...response, runs: [terminal, { ...terminal, runId: 'new', status: liveStatus }] }, selection).runtimeRun?.runId).toBe('new');
  }
});

it.each(['hatchet', 'smatchet'])('carries %s delegation provenance from the active child, not provider role', (agentId) => {
  const { runtimeRun } = projectChatActivity({ ok: true, runs: [], subagents: [{ id: 'child', runId: 'child-run', agentId, sessionId: 'child-session', parentSessionId: 'default', purpose: 'Review the interface', status: 'running' }] }, { ...selection, agentId, sessionId: 'child-session', isChildSession: true });
  expect(runtimeRun).toMatchObject({ latestUserMessage: 'Review the interface', userMessageMetadata: { kind: 'subagent-delegated-task', parentAgentId: agentId, subagentId: 'child' } });
  const operatorRun = projectChatActivity({ ok: true, runs: [{ agentId, sessionId: 'child-session', runId: 'operator-run', status: 'running', latestUserMessage: 'Actual operator followup' }] }, { ...selection, agentId, sessionId: 'child-session', isChildSession: true }).runtimeRun;
  expect(operatorRun?.userMessageMetadata).toBeUndefined();
});
