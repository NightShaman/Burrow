import { createChatStreamDelta } from './chat-stream-delta.mjs';
import { classifyRuntimeOutcome } from './runtime-outcome.mjs';
import { safeOperationalError } from './runtime-server-log.mjs';

export function taskExecutionMessage(task, project) {
  return [
    'Task-board execution request. Work this task now and report concise evidence, blockers, and any changed files. Keep this task’s status aligned with your work: move it to `in_progress` when you begin execution and to `review` when the work is complete and ready for operator review. These transitions do not require confirmation. The operator owns the final move to `done`; do not mark tasks done yourself. Confirm other changes to task fields, assignment, or metadata with the operator unless already authorized.',
    `Task ID: ${task.id}`,
    `Task execution project: ${project.name} (${project.id})`,
    project.description ? `Project description: ${project.description}` : null,
    project.notes ? `Project notes:\n${project.notes}` : null,
    project.pathEntries?.length ? `Project paths:\n${project.pathEntries.map((entry) => `- ${entry.label}: ${entry.path}${entry.note ? ` — ${entry.note}` : ''}`).join('\n')}` : null,
    'This task project context applies to this task run only. It does not change the conversation active project. Project paths are orientation, not authorization or proof of current filesystem state.',
    `Title: ${task.title}`,
    `Priority: ${task.priority}`,
    task.description ? `Description:\n${task.description}` : null,
    Object.keys(task.metadata || {}).length ? `Metadata:\n${JSON.stringify(task.metadata, null, 2)}` : null,
  ].filter(Boolean).join('\n\n');
}


/** Shared board admission/dispatch: both Execute and scheduler await this owner. */
export function createBoardTaskExecutor({
  withTaskBoard, resolveAgentRuntime, createChatTurnRunId, runChatTurnFromBody,
  projectRoot, postgresApplication, otelRuntime = null, requestLifecycle = null,
  activeChatRuns = new Map(), sessionContinuityHeads = new Map(),
  activeChatRunKey = (a, r) => `${a}:${r}`,
  sessionContinuityHeadKey = (a, s) => `${a}:${s}`,
  RUN_CANCELLATION_GRACE_MS = 5000,
  retireCancelledRun = () => {}, registerRuntimeActiveRun = () => ({ finish() {} }),
  publicChatProgress = () => null, observeModelRecovery = () => {},
  serverLogger = null, applyModelRecoveryProgress = () => false,
  updateContextUsageHighWater = (_previous, value) => value,
  taskExecutionMessage: messageBuilder = taskExecutionMessage,
} = {}) {
  const taskExecutionMessage = messageBuilder;
  async function executeBoardTask(taskId, options = {}) {
    const lifecycle = typeof requestLifecycle === 'undefined' ? null : requestLifecycle;
    const dispatch = await withTaskBoard(async (store) => {
      const task = await store.getTask(taskId);
      if (!task) return { ok: false, ...(options.scheduled ? { skipped: true } : {}), error: 'task_not_found' };
      if (options.scheduled && task.status !== 'todo') return { ok: false, skipped: true, error: 'scheduled_job_task_not_todo', task };
      if (options.scheduled && task.assignedAgentId !== options.agentId) return { ok: false, skipped: true, error: 'scheduled_job_task_agent_mismatch', task };
      if (!task.assignedAgentId) return { ok: false, error: 'task_assigned_agent_required', task };
      if (['done', 'cancelled'].includes(task.status)) return { ok: false, error: 'task_not_executable', task };
      if (options.validate) await options.validate();
      options.abortSignal?.throwIfAborted();
      const agentRuntime = await resolveAgentRuntime(task.assignedAgentId);
      // Board tasks deliberately execute where Rob works: the assigned agent's
      // main/default conversation. The task record, not a task-specific session,
      // is the durable execution owner.
      const sessionId = 'default';
      const runId = options.runId || createChatTurnRunId({ sessionId, prefix: 'task' });
      lifecycle?.signal.throwIfAborted();
      options.abortSignal?.throwIfAborted();
      let updated;
      try {
        updated = await store.startExecution(task.id, { agentId: agentRuntime.agentId, sessionId, runId, ...(options.scheduled ? { requiredStatus: 'todo', scheduledRunId: options.scheduledRunId || null } : {}) }, { actor: options.scheduled ? { type: 'agent', id: agentRuntime.agentId } : { type: 'operator', id: 'default' } });
      } catch (error) {
        if (['task_execution_running', 'task_not_executable', 'task_assigned_agent_required', 'task_assigned_agent_changed', 'scheduled_job_task_not_todo'].includes(error?.message))
          return { ok: false, ...(options.scheduled ? { skipped: true } : {}), error: error.message };
        throw error;
      }
      if (!updated) return { ok: false, ...(options.scheduled ? { skipped: true } : {}), error: 'task_not_found' };
      // Only a successful durable claim may register or enqueue work. Use the
      // locked task snapshot rather than the preflight read for the prompt.
      // A task can move projects while the claim waits for its row lock.
      let project;
      try {
        project = await store.getProject(updated.projectId);
        if (!project) throw new Error('task_project_not_found');
        if (options.onAdmitted) await options.onAdmitted({ runId, agentId: agentRuntime.agentId, sessionId });
      } catch (error) {
        // No turn has been registered or dispatched. Release only this known
        // failed admission via the existing owner CAS; never reset other claims.
        const message = String(error?.message || error);
        try {
          await store.recordExecution(updated.id, { agentId: agentRuntime.agentId, sessionId, runId, ok: false, error: message, result: { answerText: null, blockers: [message], verification: null, completionEvidence: null } }, { actor: { type: 'agent', id: agentRuntime.agentId } });
        } catch (recoveryError) {
          // Persistence is unavailable: retain the fail-closed claim and surface
          // both failures instead of claiming the task is safe to retry.
          const failure = new AggregateError([error, recoveryError], 'task_execution_pre_dispatch_recovery_failed', { cause: error });
          // Preserve only diagnostic fields, not arbitrary error properties or
          // credentials. The request logger applies its normal bounds/redaction;
          // keep this separate from `details`, which is exposed over HTTP.
          const diagnostic = (error) => safeOperationalError(error);
          failure.taskExecutionDiagnostics = {
            taskId: updated.id, runId, agentId: agentRuntime.agentId, sessionId,
            projectReadError: diagnostic(error), recoveryWriteError: diagnostic(recoveryError),
          };
          throw failure;
        }
        throw error;
      }
      return { ok: true, task: updated, project, agentRuntime, sessionId, runId, updated };
    });
    if (!dispatch.ok) return dispatch;
    const { task, project, agentRuntime, sessionId, runId, updated } = dispatch;
    const controller = new AbortController();
    const message = [taskExecutionMessage(task, project), String(options.extraInstructions || '').trim()].filter(Boolean).join('\n\n');
    const record = { agentId: agentRuntime.agentId, runId, sessionId, controller, startedAt: new Date().toISOString(), phase: 'thinking', latestUserMessage: message, objective: message, progress: [], contextUsage: null, cancelled: false, reason: null, detached: true, steeringReady: false, taskId: task.id };
    const headKey = sessionContinuityHeadKey(agentRuntime.agentId, sessionId);
    sessionContinuityHeads.set(headKey, record);
    activeChatRuns.set(activeChatRunKey(agentRuntime.agentId, runId), record);
    const abort = () => controller.abort(options.abortSignal.reason);
    options.abortSignal?.addEventListener('abort', abort, { once: true });
    if (options.abortSignal?.aborted) abort();
    if (lifecycle?.stopped) controller.abort(lifecycle.signal.reason);
    const emitTextDelta = createChatStreamDelta({ record, type: 'assistant.delta', runId, sessionId, write: () => {} });
    const emitThoughtDelta = createChatStreamDelta({ record, type: 'assistant.thought', runId, sessionId, write: () => {} });
    const runTaskTurn = () => Promise.resolve().then(() => runChatTurnFromBody({
      body: { message: record.latestUserMessage, sessionId, runId, abortSignal: controller.signal, ...(options.modelConnectionId ? { modelConnectionId: options.modelConnectionId, model: options.model } : {}) },
      rootDir: projectRoot,
      agentRuntime,
      stores: postgresApplication.stores,
      resolveAgentRuntime,
      telemetry: otelRuntime,
      turnSource: options.scheduled ? 'scheduled' : 'operator',
      recoveryPolicy: options.scheduled ? 'scheduled-task' : null,
      runSource: options.scheduled ? 'scheduled' : 'task-board',
      cancellationGraceMs: RUN_CANCELLATION_GRACE_MS,
      onCancellationDeadline: () => retireCancelledRun(record),
      registerNestedAgentRun: ({ agentRuntime: nestedRuntime, sessionId: nestedSessionId, runId: nestedRunId, message, source, ...a2a }) => registerRuntimeActiveRun({ agentId: nestedRuntime.agentId, sessionId: nestedSessionId, runId: nestedRunId, message, source, a2a: source === 'a2a' ? a2a : null }),
      onModelTextDelta: (delta) => { if (controller.signal.aborted || record.phase === 'cancelling') { record.phase = 'cancelling'; return; } emitTextDelta(delta); },
      onModelThoughtDelta: (delta) => { if (controller.signal.aborted || record.phase === 'cancelling') { record.phase = 'cancelling'; return; } emitThoughtDelta(delta); },
      onSteeringReady: () => { record.steeringReady = !controller.signal.aborted && record.phase !== 'cancelling'; },
      onTraceRecord: (traceRecord) => {
        const progress = publicChatProgress(traceRecord);
        if (!progress) return;
        if (progress.type === 'model.recovery') observeModelRecovery(serverLogger, traceRecord, record);
        record.progress = [...record.progress, { ...progress, runId, sessionId, ts: traceRecord.ts || new Date().toISOString() }].slice(-50);
        if (applyModelRecoveryProgress(record, progress)) return;
        if (controller.signal.aborted || record.phase === 'cancelling') { record.phase = 'cancelling'; return; }
        if (progress.type === 'context.compaction.started') record.phase = 'compacting';
        if (['context.compaction.completed', 'context.compaction.failed', 'model.started'].includes(progress.type)) record.phase = 'thinking';
        if (progress.type === 'model.completed') record.phase = 'streaming';
      },
      onModelContextUsage: async (usage) => {
        if (!usage || typeof usage !== 'object') return;
        record.contextUsage = updateContextUsageHighWater(record.contextUsage, usage);
      },
    })).catch(error => ({ ok: false, status: controller.signal.aborted ? 'cancelled' : 'failed', error: String(error?.message || error), blockers: [String(error?.message || error)] })).then(async (result) => {
      options.onFinalizing?.();
      const outcome = classifyRuntimeOutcome(result, { cancelled: controller.signal.aborted });
      const taskResult = {
        answerText: String(result.answerText || '').slice(0, 12_000) || null,
        blockers: Array.isArray(result.blockers) ? result.blockers.slice(0, 20) : [],
        verification: result.verification ? { required: Boolean(result.verification.required), ok: result.verification.ok ?? null, reason: result.verification.reason || null } : null,
        completionEvidence: result.completionEvidence || null,
      };
      const receipt = { agentId: agentRuntime.agentId, sessionId, runId, decision: result.decision || null, ...outcome, executedAt: new Date().toISOString(), traceDir: result.traceDir || null, error: outcome.ok ? null : (result.error || result.blockedReason || result.decision || outcome.status), result: taskResult };
      let recorded;
      try { recorded = await withTaskBoard(store => store.recordExecution(task.id, receipt, { actor: { type: 'agent', id: agentRuntime.agentId } })); }
      catch (error) {
        // A COMMIT acknowledgement can fail after the task receipt persisted.
        // Reconcile only this exact owner; never turn uncertain persistence into
        // a contradictory failed task or a second execution.
        const current = await withTaskBoard(store => store.getTask(task.id));
        if (current?.execution?.runId !== runId || current.execution.agentId !== agentRuntime.agentId || current.execution.sessionId !== sessionId || !['completed','failed','cancelled'].includes(current.execution.status)) throw error;
        recorded = current;
      }
      if (recorded === null) {
        const current = await withTaskBoard(store => store.getTask(task.id));
        if (current?.execution?.runId !== runId || !['completed','failed','cancelled'].includes(current.execution.status)) return { ok:false, status:'failed', decision:'superseded', runId, error:'task_execution_owner_changed' };
        recorded = current;
      }
      const canonical = recorded?.execution || receipt;
      return { ...result, ...canonical.result, status:canonical.status, ok:canonical.ok, decision:canonical.decision, error:canonical.error, traceDir:canonical.traceDir, runId };
    }).finally(() => {
      options.abortSignal?.removeEventListener('abort', abort);
      if (activeChatRuns.get(activeChatRunKey(agentRuntime.agentId, runId)) === record) activeChatRuns.delete(activeChatRunKey(agentRuntime.agentId, runId));
    });
    const completion = lifecycle ? lifecycle.track(runTaskTurn, 'task_board') : runTaskTurn();
    void completion.catch(() => {});
    // The HTTP admission response stays bounded and serializable; scheduler callers
    // await the same terminal promise rather than launching an outer agent turn.
    return Object.defineProperty({ ok: true, task: updated, execution: updated.execution }, 'completion', { value: completion });
  }

return executeBoardTask;
}
