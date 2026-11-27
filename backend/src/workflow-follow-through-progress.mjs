import { toolActivityPresentation } from './tool-activity-labels.mjs';

const limit = 60;
const identity = value => typeof value === 'string' && /^[\p{L}\p{N}_.: /@-]{1,160}$/u.test(value) ? value : null;

// This is an activity projection, not trace replay. Never retain arguments,
// checkpoint text, paths, queries, command lines, errors, or model text here.
export function createWorkflowFollowThroughProgress(runId, initial = []) {
  const events = new Map(initial.map(event => [event.data.activityId, event]));
  return {
    observe(record) {
      const native = record.source === 'native-minion-tool' ? record.publicProgress : null;
      if (native ? !['tool.started', 'tool.completed'].includes(native.type) : record.type !== 'tool') return;
      const payload = native?.data || record.payload || {};
      const activityId = identity(payload.activityId);
      const tool = identity(payload.tool);
      if (!activityId || !tool) return;
      const key = `${runId}:${activityId}`;
      const previous = events.get(key);
      const type = native?.type || (payload.phase === 'start' ? 'tool.started' : 'tool.completed');
      if (previous?.type === 'tool.completed') return;
      const data = { tool, activityId: key,
        provider: identity(payload.provider) || previous?.data.provider || null,
        mcpToolName: identity(payload.mcpToolName) || previous?.data.mcpToolName || null,
        modToolName: identity(payload.modToolName) || previous?.data.modToolName || null,
        skillId: identity(payload.skillId) || previous?.data.skillId || null,
        skillName: identity(payload.skillName) || previous?.data.skillName || null,
        ok: typeof payload.ok === 'boolean' ? payload.ok : null,
        status: identity(payload.status),
      };
      const presentation = toolActivityPresentation(data);
      events.set(key, { type, ts: record.ts, data: { ...data, label: presentation?.label || tool } });
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
