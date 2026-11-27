import { toolActivityPresentation, toolActivityStatus } from './tool-activity-labels.mjs';

const limit = 60;
const toolProgressTypes = ['tool.started', 'tool.completed'];
const identity = value => typeof value === 'string' && /^[\p{L}\p{N}_.: /@-]{1,160}$/u.test(value) ? value : null;

function publicToolIdentity(data, previous = {}) {
  return {
    tool: identity(data.tool),
    provider: identity(data.provider) || identity(previous.provider),
    mcpToolName: identity(data.mcpToolName) || identity(previous.mcpToolName),
    modToolName: identity(data.modToolName) || identity(previous.modToolName),
    skillId: identity(data.skillId) || identity(previous.skillId),
    skillName: identity(data.skillName) || identity(previous.skillName),
  };
}

// This is an activity projection, not trace replay. Never retain arguments,
// checkpoint text, paths, queries, command lines, errors, or model text here.
export function createWorkflowFollowThroughProgress(runId, initial = []) {
  const events = new Map(initial.map(event => [event.data.activityId, event]));
  return {
    observe(record) {
      const native = record.source === 'native-minion-tool' ? record.publicProgress : null;
      if (native ? !toolProgressTypes.includes(native.type) : record.type !== 'tool') return;
      const payload = native?.data || record.payload || {};
      const activityId = identity(payload.activityId);
      if (!activityId) return;
      const key = `${runId}:${activityId}`;
      const previous = events.get(key);
      const type = native?.type || (payload.phase === 'start' ? 'tool.started' : 'tool.completed');
      if (previous?.type === 'tool.completed') return;
      const data = { ...publicToolIdentity(payload, previous?.data), activityId: key,
        ok: typeof payload.ok === 'boolean' ? payload.ok : null,
        status: identity(payload.status),
      };
      if (!data.tool) return;
      const label = toolActivityPresentation(data)?.label || data.tool;
      events.set(key, { type, ts: record.ts, data: { ...data, label } });
      if (events.size > limit) events.delete(events.keys().next().value);
    },
    snapshot(registeredTool) {
      const progress = [...events.values()];
      if (registeredTool) {
        const i = progress.findLastIndex(event => event.type === 'tool.started' && event.data.tool === registeredTool);
        if (i !== -1) progress[i] = { ...progress[i], type: 'tool.completed', data: { ...progress[i].data, ok: true } };
      }
      return progress;
    },
  };
}

export function workflowFollowThroughToolActivity(progress, runId) {
  if (!Array.isArray(progress)) return null;
  const items = [];
  for (const event of progress.slice(-limit)) {
    if (!toolProgressTypes.includes(event?.type) || !event.data) continue;
    const data = publicToolIdentity(event.data);
    const id = event.data.activityId;
    if (typeof id !== 'string' || !id || !data.tool) continue;
    const status = event.type === 'tool.completed'
      ? toolActivityStatus({ card: event.data, payload: event.data }) : 'pending';
    const label = toolActivityPresentation(data)?.label || data.tool;
    items.push({ id, tool: data.tool, label, status, count: 1 });
  }
  const totalCalls = items.length;
  if (!totalCalls) return null;
  const failures = items.filter(item => item.status === 'error').length;
  const calls = `${totalCalls} tool call${totalCalls === 1 ? '' : 's'}`;
  return {
    runId,
    status: failures ? 'warn' : 'ok',
    title: failures ? 'Finished with an issue' : 'Tool activity',
    summary: failures ? `${failures} of ${calls} reported issues.` : `Used ${calls}.`,
    totalCalls,
    items,
  };
}
