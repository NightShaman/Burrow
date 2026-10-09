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
