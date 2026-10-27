import { chatTurnInputFromBody } from './chat-turn-controller.mjs';
import { activeChatRunKey } from './active-chat-runs.mjs';
import { captureSideQuestionSnapshot } from './chat-side-question.mjs';

const fail = (code, statusCode = 409) => { throw Object.assign(new Error(code), { statusCode }); };
export function createChatInputService({ stores, activeRuns, runner, resolveAgentRuntime, capture = captureSideQuestionSnapshot } = {}) {
  function target(agentId, sessionId, runId) {
    const run = activeRuns.get(activeChatRunKey(agentId, runId));
    if (!run || run.sessionId !== sessionId || run.lane === 'side_question' || run.controller.signal.aborted) fail('chat_input_target_not_active');
    return run;
  }
  async function submit(body) {
    const runtime = await resolveAgentRuntime(body.agentId);
    const normalized = chatTurnInputFromBody({ body });
    const identity = { agentId: runtime.agentId, sessionId: normalized.sessionId };
    const input = { ...identity, intent: body.intent, generation: body.generation, idempotencyKey: body.idempotencyKey,
      message: normalized.message, attachments: normalized.args.attachments || [], targetRunId: body.targetRunId || null, promotedFrom: body.promotedFrom || null };
    if (!['queue_next', 'side_question'].includes(body.intent)) fail('chat_input_invalid_intent', 400);
    // Retry accepted work without requiring the old main run still to be live.
    const replay = await stores.chatInputs.findByKey?.(input);
    let snapshot = null;
    if (!replay && body.intent === 'side_question') {
      const run = target(identity.agentId, identity.sessionId, body.targetRunId);
      snapshot = await capture({ stores, agentRuntime: runtime, sessionId: identity.sessionId, targetRun: run });
      if (target(identity.agentId, identity.sessionId, body.targetRunId) !== run) fail('chat_input_target_not_active');
      if (input.generation !== undefined && input.generation !== snapshot.generation) fail('chat_input_generation_conflict');
      input.generation = snapshot.generation;
    }
    if (input.promotedFrom && !replay) {
      const side = await stores.chatInputs.get({ ...identity, id: input.promotedFrom });
      if (!side || side.intent !== 'side_question' || side.status !== 'succeeded') fail('chat_input_promotion_source_invalid', 400);
      input.generation ??= side.generation;
    }
    const accepted = await stores.chatInputs.submit({ ...input, snapshot });
    void runner.wake().catch(() => {});
    return { ok: true, input: accepted };
  }
  async function list(body) {
    const runtime = await resolveAgentRuntime(body.agentId);
    return { ok: true, ...await stores.chatInputs.list({ agentId: runtime.agentId, sessionId: String(body.sessionId || 'default') }) };
  }
  async function action(id, action, body) {
    const runtime = await resolveAgentRuntime(body.agentId);
    const scope = { agentId: runtime.agentId, sessionId: String(body.sessionId || 'default'), id };
    const existing = await stores.chatInputs.get(scope);
    if (!existing) fail('chat_input_not_found', 404);
    if (body.generation !== undefined && body.generation !== existing.generation) fail('chat_input_generation_conflict');
    if (action === 'cancel') {
      // Cancel a running queued turn also holds the rest of its main queue.
      const input = await stores.chatInputs.cancel(scope);
      if (!input) fail('chat_input_not_found',404);
      if (input.status === 'running') runner.cancel(id);
      void runner.wake().catch(() => {});
      return { ok: true, input };
    }
    if (existing.status !== 'held') fail('chat_input_not_held');
    const inputs = await stores.chatInputs.resume({ ...scope, generation: existing.generation });
    void runner.wake().catch(() => {});
    return { ok: true, input: await stores.chatInputs.get(scope), inputs };
  }
  return { submit, list, action };
}
