import { describe, expect, it } from 'vitest';
import { chatLiveStageLabel, projectLiveStage } from './chatLiveStage';
describe('dispatch projection', () => {
  it('labels local dispatch without claiming acceptance', () => {
    const state = projectLiveStage({}, { type: 'model.dispatched', data: { modelCall: 1 } });
    expect(chatLiveStageLabel(state.stage)).toBe('Model request dispatched…');
  });
  it('rejects delayed older calls and dispatch after useful progress/completion', () => {
    const state = projectLiveStage({ stage: 'request-intent', modelCall: 2 }, { type: 'assistant.delta', data: { modelCall: 2 } });
    expect(projectLiveStage(state, { type: 'model.dispatched', data: { modelCall: 1 } })).toBe(state);
    expect(projectLiveStage(state, { type: 'model.dispatched', data: { modelCall: 2 } })).toBe(state);
    expect(projectLiveStage({ stage: 'model-completed', modelCall: 2 }, { type: 'model.dispatched', data: { modelCall: 2 } }).stage).toBe('model-completed');
    expect(projectLiveStage(state, { type: 'model.dispatched' })).toBe(state);
  });
});

describe('context compaction lifecycle', () => {
  it('projects live and recovered events, including no-op and failure', () => {
    const project = (events: Array<{ type: string; data?: { compressed?: boolean; reason?: string } }>) => events.reduce(projectLiveStage, {});
    expect(chatLiveStageLabel(project([{ type: 'context.compaction.started' }]).stage)).toBe('Compacting context…');
    expect(chatLiveStageLabel(project([{ type: 'context.compaction.started' }, { type: 'context.compaction.completed', data: { compressed: true } }]).stage)).toBe('Context compaction complete.');
    expect(chatLiveStageLabel(project([{ type: 'context.compaction.completed', data: { compressed: false, reason: 'no_eligible_messages' } }]).stage)).toBe('No context eligible for compaction.');
    expect(chatLiveStageLabel(project([{ type: 'context.compaction.failed' }]).stage)).toBe('Context compaction failed.');
    expect(project([{ type: 'context.compaction.completed' }, { type: 'model.started' }]).stage).toBe('request-intent');
  });
});
