import { minionOutcome } from '../../app/minionOutcome';
import { projectLiveStage, type LiveStageProjection, type ChatLiveStage } from './chatLiveStage';
import type { ActiveA2AActivity, ActiveChatRun, ActiveChatRunsResponse, ActiveSubagent, ProgressEntry, ToolActivity, ToolActivityItem } from '../../app/api';
import { thoughtProgressFromEvents } from './chatThoughtProgress';

export type RuntimeRunForSelection = {
  targetId: string;
  runId: string;
  agentId: string;
  sessionId: string;
  latestUserMessage: string;
  answerText?: string;
  progress: ProgressEntry[];
  stage?: ChatLiveStage;
  toolActivity?: ToolActivity;
  subagent?: ActiveSubagent;
};

function runtimeRunProgress(run: ActiveChatRun): ProgressEntry[] {
  return thoughtProgressFromEvents(run.progress ?? [], run.runId);
}

function runtimeToolActivity(run: ActiveChatRun): ToolActivity | undefined {
  const itemsById = new Map<string, ToolActivityItem>();
  for (const [index, event] of (run.progress ?? []).entries()) {
    if (event.type !== 'tool.started' && event.type !== 'tool.completed') continue;
    const data = event.data ?? {};
    const tool = typeof data.tool === 'string' ? data.tool.trim() : '';
    if (!tool) continue;
    const mcpToolName = typeof data.mcpToolName === 'string' ? data.mcpToolName.trim() : '';
    const label = tool === 'mcp_call' && mcpToolName
      ? 'MCP tool'
      : typeof data.label === 'string' && data.label.trim() ? data.label.trim() : tool.replace(/[-_]/g, ' ');
    const id = typeof data.activityId === 'string' && data.activityId ? data.activityId : `${run.runId}:tool:${index}`;
    const status = event.type === 'tool.started' ? 'pending' as const : data.ok === false || data.status === 'failed' ? 'error' as const : 'ok' as const;
    itemsById.set(id, { ...itemsById.get(id), id, label, status });
  }
  const items = [...itemsById.values()];
  if (!items.length) return undefined;
  const hasError = items.some((item) => item.status === 'error');
  const hasPending = items.some((item) => item.status === 'pending');
  return { runId: run.runId, items, status: hasError ? 'warn' : hasPending ? 'running' : 'ok' };
}

function runtimeRunForSelection(run: ActiveChatRun | undefined, targetId: string): RuntimeRunForSelection | null {
  if (!run) return null;
  const owner = run;
  run = { ...run, progress: (run.progress ?? []).filter((event) => (event.runId === undefined || event.runId === owner.runId) && (event.sessionId === undefined || event.sessionId === owner.sessionId)) };
  return { targetId, runId: run.runId, agentId: run.agentId, sessionId: run.sessionId, answerText: typeof run.answerText === 'string' ? run.answerText : '', latestUserMessage: typeof run.latestUserMessage === 'string' ? run.latestUserMessage : '', stage: (run.progress ?? []).reduce<LiveStageProjection>((state, event) => ((event.runId !== undefined && event.runId !== run.runId) || (event.sessionId !== undefined && event.sessionId !== run.sessionId)) ? state : projectLiveStage(state, event), {}).stage, progress: runtimeRunProgress(run), toolActivity: runtimeToolActivity(run) };
}

function formatElapsed(from: string | null | undefined, to: number) {
  if (!from) return '';
  const at = new Date(from).getTime();
  if (!Number.isFinite(at)) return '';
  const seconds = Math.max(0, Math.floor((to - at) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function subagentToolActivity(child: ActiveSubagent, now: number): ToolActivity {
  const activity = child.activity ?? {};
  const status = String(activity.status || child.status || '').toLowerCase();
  const final = child.final === true || ['completed', 'succeeded', 'failed', 'cancelled', 'incomplete', 'timed_out'].includes(status);
  const outcome = minionOutcome(child.status, child.result);
  const hasError = Boolean(activity.error) || outcome.label === 'Error' || (status === 'failed' && outcome.label !== 'Incomplete');
  const hasWarning = hasError || outcome.label === 'Incomplete';
  const rawLabel = activity.tool || activity.label || activity.model || activity.phase || child.phase || child.status || 'Subagent activity';
  const age = formatElapsed(activity.lastActualActivityAt || child.lastActualActivityAt, now);
  const elapsed = formatElapsed(activity.startedAt, now);
  const detail = [
    activity.kind ? `${activity.kind}` : null,
    activity.model ? `model ${activity.model}` : null,
    elapsed ? `elapsed ${elapsed}` : null,
    age ? `last actual event ${age} ago` : null,
    activity.error || null,
    outcome.reason,
  ].filter(Boolean).join(' · ');
  return {
    runId: child.runId || child.id,
    status: hasWarning ? 'warn' : final ? 'ok' : 'running',
    title: final ? 'Minion activity' : 'Minion running',
    summary: detail || undefined,
    items: [{ id: `${child.id}:${activity.sequence ?? 'activity'}`, label: activity.error ? 'Error' : outcome.label ?? String(rawLabel), status: hasWarning ? 'error' : final ? 'ok' : 'pending', ...(detail ? { detail } : {}) }],
  };
}

function runtimeRunForSubagent(child: ActiveSubagent | undefined, targetId: string, now: number): RuntimeRunForSelection | null {
  if (!child || child.final) return null;
  const runId = child.runId || child.id;
  const agentId = child.agentId || '';
  const traceChildSessionId = child.trace && 'childSessionId' in child.trace && typeof child.trace.childSessionId === 'string' ? child.trace.childSessionId : '';
  const sessionId = child.sessionId || traceChildSessionId || '';
  if (!runId || !agentId || !sessionId) return null;
  return { targetId, runId, agentId, sessionId, latestUserMessage: child.purpose || child.label || '', progress: [], toolActivity: subagentToolActivity(child, now), subagent: child };
}

/** Pure active-run projection. Selection and clock are inputs, never global state. */
export function projectChatActivity(response: ActiveChatRunsResponse, { agentId, sessionId, isChildSession, hadRuns, now }: { agentId: string; sessionId: string; isChildSession: boolean; hadRuns: boolean; now: number }) {
  const selectedRuntimeRun = response.runs?.find((run) => run.agentId === agentId && run.sessionId === sessionId);
  const matchingLiveSubagents = (response.subagents ?? []).filter((child) => {
    const traceChildSessionId = child.trace && 'childSessionId' in child.trace && typeof child.trace.childSessionId === 'string' ? child.trace.childSessionId : '';
    const childAgentId = child.agentId || '';
    const parentRunId = child.parentRunId || (child.trace && 'runId' in child.trace && typeof child.trace.runId === 'string' ? child.trace.runId : '');
    return !child.final
      && (child.parentSessionId === sessionId || (isChildSession && (child.sessionId === sessionId || traceChildSessionId === sessionId)))
      && (!childAgentId || childAgentId === agentId)
      && (!parentRunId || !selectedRuntimeRun || parentRunId === selectedRuntimeRun.runId);
  });
  const childActivities = matchingLiveSubagents.map((child) => subagentToolActivity(child, now));
  const projectedRuntimeRun = runtimeRunForSelection(selectedRuntimeRun, 'local') ?? runtimeRunForSubagent(isChildSession ? matchingLiveSubagents[0] : undefined, 'local', now);
  const activities = (response.runs ?? []).flatMap((run) => {
    if (run.a2aActivities?.length) return run.a2aActivities;
    if (run.source !== 'a2a' || !run.a2a) return [];
    const status: ActiveA2AActivity['status'] = run.status === 'cancelled' ? 'cancelled' : run.phase === 'streaming' ? 'streaming' : 'running';
    return [{ id: `a2a:${run.runId}`, status, parentAgentId: run.a2a.parentAgentId, recipient: { agentId: run.agentId, sessionId: run.sessionId, runId: run.runId }, messageMode: run.a2a.messageMode, progress: run.progress ?? [] }];
  });
  const hasLiveSubagents = Boolean(matchingLiveSubagents.length);
  const shouldRefresh = isChildSession || Boolean(response.runs?.length) || hasLiveSubagents || hadRuns;
  return { runtimeRun: projectedRuntimeRun, childActivities, a2aActivities: activities.slice(-12), shouldRefresh, hadRuns: Boolean(response.runs?.length) || hasLiveSubagents };

}
