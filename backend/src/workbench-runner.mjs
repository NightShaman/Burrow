import path from 'node:path';
import { createTraceLogger } from './trace-logger.mjs';
import { loadRuntimeConfig } from './app-runtime.mjs';
import { runBurrow } from './runner.mjs';
import { reviewProposalActions } from './action-safety.mjs';
import { runExec } from './harness/exec.mjs';
import { workbenchWorkflow } from './workbench-workflow.mjs';
import { routeRequest } from './request-router.mjs';
import { resolveRuntimeTracePath, resolveSkillsConfig } from './config.mjs';
import { planTurn } from './turn-planner.mjs';
import { resolveExecutionTarget } from './execution-context.mjs';

const STEPS = new Set(['inspect', 'propose', 'verify', 'factory']);

function workbenchCwd(rootDir, workspaceRoot) {
  return workspaceRoot || rootDir || process.cwd();
}

function compactRun(result) {
  return {
    ok: result.ok,
    decision: result.decision,
    blockers: result.blockers || [],
    warnings: result.warnings || [],
    runId: result.runId,
    traceDir: result.traceDir,
    proposedActions: result.proposedActions || [],
    proposedActionCount: result.proposedActions?.length || 0,
    proposalReview: result.proposalReview || null,
    proposalExecution: result.proposalExecution ? { executed: result.proposalExecution.executed || 0, skipped: result.proposalExecution.skipped || [] } : null,
    verification: result.verification || null,
    commit: result.commit || null,
  };
}

export async function runWorkbenchStep({ rootDir, configPath, step = 'inspect', message, workspaceRoot, target = null, verifyCommand = null, runId = null, conversationId = null, args = {}, parentPermissions = null, agentRuntime = null, ...legacyOptions } = {}) {
  if (!rootDir) throw new Error('rootDir is required');
  if (!message) throw new Error('message is required');
  if (!STEPS.has(step)) throw new Error(`unsupported workbench step: ${step}`);
  const authorityKeys = ['agent_id', 'agent_workspace_root', 'agent_data_root', 'skills_root', 'filesystem_boundaries', 'data_root'];
  if (agentRuntime) {
    for (const key of authorityKeys) if (args[key] !== undefined) throw new Error(`agent_runtime_override_forbidden:${key}`);
  }
  const runtime = await loadRuntimeConfig({ rootDir, configPath, args });
  if (agentRuntime) {
    runtime.runtimeState = {
      ...runtime.runtimeState,
      agentId: agentRuntime.agentId,
      agentWorkspaceRoot: path.resolve(agentRuntime.agentWorkspaceRoot),
      agentDataRoot: path.resolve(agentRuntime.agentDataRoot),
      skillsRoot: path.resolve(agentRuntime.skillsRoot),
      filesystemBoundaries: agentRuntime.filesystemBoundaries.map((item) => path.resolve(item)),
    };
    // Private agent roots are state context, not a forced execution cwd.
    // Preserve the selected workbench/project root when one was supplied.
  }
  const resolvedRunId = runId || `workbench-${step}`;
  const cwd = workbenchCwd(rootDir, workspaceRoot);
  const inheritedPermissions = parentPermissions || legacyOptions['parent' + 'Authority'] || args.parentPermissions || args['parent' + 'Authority'] || null;
  // Agent-bound adapters supply immutable boundaries. Legacy direct callers
  // retain their prior structural-target behavior for compatibility.
  const filesystemBoundaries = agentRuntime
    ? runtime.runtimeState.filesystemBoundaries
    : (Array.isArray(args.filesystem_boundaries) ? args.filesystem_boundaries : null);
  const resolvedTarget = target ? await resolveExecutionTarget(target, filesystemBoundaries ? { filesystemBoundaries } : {}) : null;

  if (step === 'inspect') {
    const result = await runBurrow({
      rootDir,
      message,
      mode: 'dry-run',
      runId: resolvedRunId,
      workspaceRoot,
      action: 'plan',
      skillConfig: runtime.skillsConfig,
      contextThreshold: runtime.contextConfig.contextThreshold,
    });
    return { ok: result.ok, step, decision: result.decision, mayMutateInline: false, mayCommitInline: false, result: compactRun(result) };
  }

  if (step === 'propose') {
    const result = await runBurrow({
      rootDir,
      message,
      mode: 'model',
      runId: resolvedRunId,
      workspaceRoot,
      action: 'write',
      modelConfig: runtime.modelConfig,
      skillConfig: runtime.skillsConfig,
      contextThreshold: runtime.contextConfig.contextThreshold,
      executeProposals: false,
      allowMutationProposals: false,
      commitChanges: false,
    });
    return { ok: result.ok, step, decision: result.decision, mayMutateInline: false, mayCommitInline: false, result: compactRun(result) };
  }

  if (step === 'verify') {
    if (!verifyCommand) return { ok: false, step, decision: 'blocked', blockers: ['verify_command_required'], mayMutateInline: false, mayCommitInline: false };
    // Verification traces are runtime diagnostics, not workspace content. Keep them under
    // the configured cache trace root so a workspace inspection cannot discover them.
    const logger = createTraceLogger({ rootDir: resolveRuntimeTracePath({ ...runtime.runtimeState, sessionId: 'default' }), runId: resolvedRunId });
    const review = reviewProposalActions({ actions: [{ index: 0, tool: 'shell_exec', command: verifyCommand }], workspaceRoot }).reviews[0];
    if (review.status !== 'allowed') {
      await logger.router({ stage: 'workbench-verify-blocked', review });
      return { ok: false, step, decision: 'blocked', blockers: [`verify_command_not_allowed:${review.status}`], review, runId: logger.runId, traceDir: logger.traceDir, mayMutateInline: false, mayCommitInline: false };
    }
    const execResult = { ...await runExec({ command: verifyCommand, cwd, traceLogger: logger, artifactPrefix: 'workbench-verify' }), verificationCheck: true };
    await logger.router({ stage: 'workbench-verify-result', ok: execResult.ok, command: verifyCommand, verificationCheck: true });
    return { ok: execResult.ok, step, decision: execResult.ok ? 'verified' : 'verification_failed', runId: logger.runId, traceDir: logger.traceDir, review, verification: { command: verifyCommand, ok: execResult.ok, exitCode: execResult.exitCode, verificationCheck: true, result: execResult }, mayMutateInline: false, mayCommitInline: false };
  }

  const route = await routeRequest({
    rootDir,
    message,
    skillConfig: runtime.skillsConfig || resolveSkillsConfig({}),
    workspaceContext: { workspaceRoot },
  });
  const factoryMessage = `${message}\nfactory`;
  const turnPlan = planTurn({ message: factoryMessage, action: 'write', workspaceContext: { workspaceRoot } });
  const session = { kind: 'factory', reason: 'explicit_workbench_step', workspaceRoot };
  const actionRoute = { kind: 'factory', route: 'workbench.factory', reason: 'factory_preview' };
  return {
    ok: true,
    step,
    decision: 'factory_preview',
    mayMutateInline: false,
    mayCommitInline: false,
    workflow: workbenchWorkflow({ session: { ...session, kind: 'factory' }, actionRoute: { ...actionRoute, kind: 'factory' }, workspaceRoot }),
    escalationCommand: 'burrow factory --root DIR --workspace-root WORKSPACE --message TEXT',
  };
}
