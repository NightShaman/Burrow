#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { routeRequest } from '../src/request-router.mjs';
import { assemblePrompt } from '../src/prompt-assembler.mjs';
import { createTraceLogger } from '../src/trace-logger.mjs';
import { runBurrow } from '../src/runner.mjs';
import { loadBurrowConfig, resolveModelConfig, resolveExecutionConfig, configDefaults, resolveRuntimeStateConfig, resolveRuntimeTracePath, resolveRuntimeTraceRoot, resolveRetentionConfig, resolveSkillsConfig, resolveContextConfig } from '../src/config.mjs';
import { runDoctor } from '../src/doctor.mjs';
import { latestTraceRun, summarizeTrace } from '../src/trace-summary.mjs';
import { parseActionProposal } from '../src/action-proposal.mjs';
import { reviewProposalActions } from '../src/action-safety.mjs';
import { runExec } from '../src/harness/exec.mjs';
import { createOpenAICompatibleModelAdapter } from '../src/model-adapter.mjs';
import { loadRuntimeConfig, runAskChat } from '../src/app-runtime.mjs';
import { runRetentionCleanup } from '../src/retention.mjs';
import { searchSessionEvidence } from '../src/session-search.mjs';
import { translateBlockers } from '../src/workbench-status.mjs';
import { WorkingMemoryStore } from '../src/working-memory-store.mjs';
import { consolidateDreamMemory } from '../src/dream-memory-consolidator.mjs';
import { runDreamCycle } from '../src/dream-cycle-runner.mjs';
import { ensureDefaultGlobalWorkspace } from '../src/runtime-workspace-defaults.mjs';
import { createPortableInstallBackup, formatPortableInstallResult, planPortableInstallBackup, planPortableInstallRestore, restorePortableInstall } from '../scripts/portable-install-backup.mjs';

function usage() {
  return `Usage:
  burrow ask --root DIR --message TEXT [--session-id ID] [--call-model] [--json]
  burrow chat --root DIR --message TEXT [--session-id ID] [--call-model] [--json]
  burrow plan --root DIR --message TEXT [--json]
  burrow trace --root DIR --run-id ID|--latest [--json] [--tool-output]
  burrow session-search --root DIR --session-id ID [--query TEXT] [--role any|user|assistant|summary] [--json]
  burrow run --root DIR --message TEXT --dry-run|--call-model
  burrow factory --root DIR --workspace-root DIR --message TEXT [--max-turns N]
  burrow review-proposal --root DIR --message JSON|--proposal-file PATH
  burrow doctor --root DIR [--check-memory]
  burrow retention --root DIR [--confirm] [--summary]
  burrow dream-memory --root DIR [--agent-id ID] [--limit N] [--json]
  burrow dream-cycle --root DIR [--agent-id ID] [--limit N] [--json]
  burrow serve --root DIR [--host HOST] [--port PORT] [--context-threshold RATIO]
  burrow install-backup --output FILE [--root DIR] [--confirm] [--json]
  burrow install-restore --archive FILE [--home DIR] [--replace] [--confirm] [--json]

Options:
  --root DIR              Burrow project root
  --message TEXT          User/task message or proposal JSON for review-proposal
  --proposal-file PATH    Read proposal JSON/text from file for review-proposal
  --json                  Print full JSON result
  --run-id ID             Trace run id
  --session-id ID         Persistent ask/chat session id
  --latest                Summarize the most recently modified trace run
  --tool-output           Include compact tool stdout/stderr previews in trace summary
  --query TEXT            Search query for session-search
  --role ROLE             Role filter for session-search: any, user, assistant, summary
  --source-id ID          Find raw/source evidence related to a compression source entry id
  --workspace-root DIR    Workspace/repo root for workspace diagnostics
  --action ACTION         Policy action hint: plan/write/edit/patch/delete
  --call-model            Call configured OpenAI-compatible model after gates pass
  --no-call-model         For ask: route/trace only without calling a model
  --model-base-url URL    OpenAI-compatible model API base URL
  --model MODEL           Model id/name
  --model-api MODE        Model API mode: openai-chat-completions or openai-responses
  --model-api-key KEY     Model API key value
  --model-api-key-env ENV Read model API key from environment variable
  --model-api-key-env-file PATH Env file containing model API key
  --model-temperature N   Model temperature
  --model-max-tokens N    Model max_tokens
  --verify-command CMD    Run command after model call and use result as verification evidence
  --commit-changes        Commit verified workspace changes after successful verification
  --commit-message TEXT   Commit message for --commit-changes or factory
  --max-turns N           Factory: allow up to N model/action turns for inspect-then-write loops
  --allow-dirty-worktree  Factory: allow running when workspace git status is dirty
  --allow-protected-branch Factory: allow running on protected branches like main/master
  --autonomy-profile NAME Execution profile: conservative, local-dev, trusted-autonomy
  --execute-proposals     Execute reviewed allowed proposal actions only (files_read and safe shell_exec)
  --allow-review-required-proposals
                          Also execute local exec proposals classified review_required
  --allow-mutation-proposals
                          Allow execution of reviewed write/patch proposals
  --file PATH             Policy file target hint; may be repeated later
  --data-root DIR         Override runtime data root; trace retention uses configured cache root
  --host HOST             Serve host for burrow serve
  --port PORT             Serve port for burrow serve
  --context-threshold RATIO Temporary context compression threshold for this serve process
  --confirm              Actually delete retention cleanup candidates; omitted means dry-run
  --summary              Print only the retention plan summary; omit individual candidate paths
  --agent-id ID          Agent id for agent-scoped commands; defaults to hatchet
  --mode MODE            Dream mode: light (recent sessions to local SQLite) or deep (durable Brain candidates)
  --days N               Dream evidence window: defaults to 5 for light, 30 for deep
  --apply                Apply curated Dream candidates; omitted is a read-only dry run
  --model-profile NAME  Model profile for this Dream run (for example, mini)
  --scope-review         Hold Light Dream candidates locally for later scope assignment; no preload or Brain write
  --review-index N       Scope-review queue item to assign into local project working memory
`;
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const key = arg.slice(2).replaceAll('-', '_');
    if (key === 'run_preflights') throw new Error('--run-preflights was retired; memory recall is configured directly');
    if (key === 'json' || key === 'latest' || key === 'tool_output' || key === 'dry_run' || key === 'call_model' || key === 'no_call_model' || key === 'execute_proposals' || key === 'allow_review_required_proposals' || key === 'allow_mutation_proposals' || key === 'commit_changes' || key === 'check_memory' || key === 'allow_dirty_worktree' || key === 'allow_protected_branch' || key === 'confirm' || key === 'summary' || key === 'apply' || key === 'scope_review' || key === 'replace' || key === 'help' || key === 'h') {
      out[key] = true;
      continue;
    }
    const value = argv[++i];
    if (value === undefined) throw new Error(`--${arg.slice(2)} requires a value`);
    out[key] = value;
  }
  return out;
}



function compactPlan(result) {
  return {
    runId: result.runId,
    traceDir: result.traceDir,
    selectedSkills: result.route.skills.selected.map((skill) => skill.id),
    needsWorkspace: result.route.action.needsWorkspace,
    promptChars: result.prompt.stats.totalChars,
    promptSections: result.prompt.stats.sections,
    policyOk: result.policy?.ok ?? null,
    policyBlockers: result.policy?.blockers ?? [],
    policyBoundaries: translateBlockers(result.policy?.blockers ?? []),
    policyWarnings: result.policy?.warnings ?? [],
  };
}

function compactAskChatText(result = {}) {
  if (result.answerText) return result.answerText;
  if (result.question) return result.question;
  if (result.decision === 'routed') return `Routed ${result.session?.kind || 'request'} request.`;
  if (result.decision === 'model_failed') return `Model failed: ${result.model?.error || result.error || 'model error'}.`;
  if (result.workbenchStatus?.blockers?.length) return `Blocked: ${result.workbenchStatus.blockers.map((item) => item.message || item.code).join(', ')}.`;
  return result.ok ? 'Done.' : `Blocked: ${result.decision || 'unknown'}.`;
}

function compactToolResult(result = {}) {
  return {
    tool: result.tool || null,
    ok: result.ok ?? null,
    command: result.command || null,
    filePath: result.filePath || null,
    touchedFiles: result.touchedFiles || undefined,
    exitCode: result.exitCode ?? undefined,
    error: result.error || null,
    artifacts: result.artifacts || {},
  };
}

function compactProposalExecution(execution) {
  if (!execution) return null;
  return {
    executed: execution.executed,
    skipped: execution.skipped?.length ?? 0,
    skippedActions: execution.skipped ?? [],
    tools: (execution.toolResults || []).map(compactToolResult),
  };
}

function parsePositiveInt(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 1) throw new Error('--max-turns must be a positive integer');
  return parsed;
}

function mutationExecuted(result) {
  return (result?.proposalExecution?.toolResults || []).some((toolResult) => ['files_write', 'files_patch'].includes(toolResult.tool) && toolResult.ok);
}

function summarizeFactoryTurn(result, turn) {
  const tools = (result?.proposalExecution?.toolResults || []).map((toolResult) => {
    const parts = [`${toolResult.tool}:${toolResult.ok ? 'ok' : 'failed'}`];
    if (toolResult.filePath) parts.push(`file=${toolResult.filePath}`);
    if (toolResult.command) parts.push(`command=${toolResult.command}`);
    if (toolResult.error) parts.push(`error=${toolResult.error}`);
    if (toolResult.stdout) parts.push(`stdout=${String(toolResult.stdout).slice(0, 500)}`);
    if (toolResult.stderr) parts.push(`stderr=${String(toolResult.stderr).slice(0, 500)}`);
    return `- ${parts.join(' ')}`;
  });
  return [
    `Turn ${turn}: outcome=${result?.decision} answer=${result?.answerText || ''}`,
    `proposedActions=${result?.proposedActions?.length ?? 0} executed=${result?.proposalExecution?.executed ?? 0} verification=${result?.verification?.reason || 'none'}`,
    ...tools,
  ].join('\n');
}

function continueFactory(result, turn, maxTurns) {
  if (turn >= maxTurns) return false;
  if (result?.ok) return false;
  if (result?.decision === 'blocked' || result?.decision === 'model_failed') return false;
  if (mutationExecuted(result)) return false;
  if (result?.verification?.reason === 'verification_check_failed') return false;
  return (result?.proposalExecution?.executed || 0) > 0;
}

async function factoryDirtyWorktreeBlock({ rootDir, runId, workspaceRoot }) {
  const status = await runExec({
    command: 'git status --porcelain',
    cwd: workspaceRoot,
    rootDir,
    runId: `${runId}-clean-worktree`,
    artifactPrefix: 'factory-clean-worktree-status',
  });
  const dirty = Boolean(status.stdout.trim());
  if (!dirty) return null;
  return {
    ok: false,
    mode: 'model',
    decision: 'blocked',
    blockers: ['dirty_worktree'],
    warnings: [],
    runId,
    workspaceRoot,
    worktreeStatus: status.stdout,
    worktreeStatusCommandOk: status.ok,
    execution: { profile: 'factory', allowDirtyWorktree: false },
    proposalExecution: { executed: 0, skipped: 0, skippedActions: [], tools: [] },
    verification: { required: false, ok: true, reason: 'not_started', requiredEvidence: [], evidence: { artifacts: 0, checks: 0 } },
    commit: { ok: false, skipped: true, reason: 'dirty_worktree' },
  };
}

async function factoryProtectedBranchBlock({ rootDir, runId, workspaceRoot }) {
  const branch = await runExec({
    command: 'git branch --show-current',
    cwd: workspaceRoot,
    rootDir,
    runId: `${runId}-protected-branch`,
    artifactPrefix: 'factory-protected-branch',
  });
  const branchName = branch.stdout.trim();
  if (!['main', 'master'].includes(branchName)) return null;
  return {
    ok: false,
    mode: 'model',
    decision: 'blocked',
    blockers: ['protected_branch'],
    warnings: [],
    runId,
    workspaceRoot,
    branch: branchName,
    execution: { profile: 'factory', allowProtectedBranch: false },
    proposalExecution: { executed: 0, skipped: 0, skippedActions: [], tools: [] },
    verification: { required: false, ok: true, reason: 'not_started', requiredEvidence: [], evidence: { artifacts: 0, checks: 0 } },
    commit: { ok: false, skipped: true, reason: 'protected_branch' },
  };
}

async function runFactoryWithTurns({ maxTurns, message, runOptions }) {
  const turns = [];
  const observations = [];
  let result = null;

  for (let turn = 1; turn <= maxTurns; turn += 1) {
    const turnMessage = observations.length === 0
      ? message
      : `${message}\n\nSame-run tool results:\n${observations.join('\n\n')}\n\nUse these tool results. If implementation is now possible, propose concrete files_write/files_patch actions and a check-like verification command.`;

    result = await runBurrow({
      ...runOptions,
      message: turnMessage,
      runId: maxTurns > 1 ? `${runOptions.runId}-turn-${turn}` : runOptions.runId,
    });
    turns.push({
      turn,
      runId: result.runId,
      traceDir: result.traceDir,
      ok: result.ok,
      decision: result.decision,
      answerText: result.answerText,
      proposedActionCount: result.proposedActions?.length ?? 0,
      executed: result.proposalExecution?.executed ?? 0,
      verification: result.verification,
      mutationExecuted: mutationExecuted(result),
    });

    if (!continueFactory(result, turn, maxTurns)) break;
    observations.push(summarizeFactoryTurn(result, turn));
  }

  return { result, turns };
}

async function inferFactoryVerifyCommand({ workspaceRoot, explicitVerifyCommand = null } = {}) {
  if (explicitVerifyCommand) return explicitVerifyCommand;
  if (!workspaceRoot) return null;
  try {
    const packageJson = JSON.parse(await fs.readFile(path.join(workspaceRoot, 'package.json'), 'utf8'));
    if (packageJson?.scripts?.test) return 'npm test';
  } catch {}
  return null;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === '--help' || command === '-h') {
    console.log(usage());
    return;
  }
  if (command !== 'install-backup' && command !== 'install-restore' && command !== 'ask' && command !== 'chat' && command !== 'plan' && command !== 'trace' && command !== 'session-search' && command !== 'run' && command !== 'factory' && command !== 'review-proposal' && command !== 'doctor' && command !== 'retention' && command !== 'dream-memory' && command !== 'dream-cycle' && command !== 'serve') throw new Error(`unknown command: ${command}`);

  const args = parseArgs(rest);
  if (args.help || args.h) {
    console.log(usage());
    return;
  }
  if (command === 'install-backup') {
    const root = args.root || process.env.BURROW_RUNTIME_ROOT;
    if (!root) throw new Error('--root is required (or set BURROW_RUNTIME_ROOT)');
    if (!args.output) throw new Error('--output is required');
    const result = args.confirm ? await createPortableInstallBackup({ root, output: args.output }) : await planPortableInstallBackup({ root, output: args.output });
    console.log(args.json ? JSON.stringify(result, null, 2) : formatPortableInstallResult(result));
    process.exitCode = result.ok ? 0 : 1; return;
  }
  if (command === 'install-restore') {
    if (!args.archive) throw new Error('--archive is required');
    if (args.replace && !args.confirm) throw new Error('--replace requires --confirm');
    const result = args.confirm ? await restorePortableInstall({ archive: args.archive, home: args.home, replace: args.replace }) : await planPortableInstallRestore({ archive: args.archive, home: args.home, replace: args.replace });
    console.log(args.json ? JSON.stringify(result, null, 2) : formatPortableInstallResult(result));
    return;
  }
  const rootDir = args.root;
  if (!rootDir) throw new Error('--root is required');

  if (command === 'serve') {
    if (args.host) process.env.BURROW_UI_HOST = args.host;
    if (args.port) process.env.BURROW_UI_PORT = args.port;
    if (args.data_root) process.env.BURROW_DATA_ROOT = args.data_root;
    if (args.context_threshold) process.env.BURROW_CONTEXT_THRESHOLD = args.context_threshold;
    const loaded = await loadBurrowConfig({ rootDir });
    const runtimeState = resolveRuntimeStateConfig({ rootDir, args, loadedConfig: loaded.config });
    await ensureDefaultGlobalWorkspace({ installDir: rootDir, workspaceRoot: runtimeState.workspaceRoot });
    await import('../scripts/burrow-ui.mjs');
    return;
  }

  if (command === 'session-search') {
    const runtimeConfig = await loadRuntimeConfig({ rootDir, args });
    const result = await searchSessionEvidence({
      rootDir: args.data_root || runtimeConfig.runtimeState.dataRoot,
      sessionId: args.session_id || 'default',
      query: args.query || args.message || args._.join(' '),
      role: args.role || 'any',
      sourceId: args.source_id || null,
      limit: args.limit || 50,
    });
    if (args.json) return console.log(JSON.stringify(result, null, 2));
    if (!result.results.length) return console.log('No session evidence found.');
    for (const entry of result.results) {
      const label = entry.compressionSummary ? 'summary' : (entry.role || entry.type);
      console.log(`${entry.ts} ${label} ${entry.id}: ${entry.contentSnippet || entry.compressionSummary?.textSnippet || ''}`);
    }
    return;
  }

  if (command === 'trace') {
    const runtimeConfig = await loadRuntimeConfig({ rootDir, args });
    const dataRoot = runtimeConfig.runtimeState.dataRoot;
    const traceRoot = await resolveRuntimeTraceRoot(rootDir, args);
    const latest = args.latest ? await latestTraceRun({ rootDir: traceRoot }) : null;
    const runId = args.run_id || latest?.runId;
    if (!runId) throw new Error('--run-id is required unless --latest finds a trace');
    const summary = await summarizeTrace({ rootDir: traceRoot, runId, includeToolOutput: Boolean(args.tool_output) });
    console.log(JSON.stringify({ ...summary, latest: Boolean(args.latest), dataRoot, traceRoot }, null, 2));
    return;
  }

  if (command === 'doctor') {
    const result = await runDoctor({ rootDir, checkMemory: Boolean(args.check_memory) });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === 'retention') {
    const loaded = await loadBurrowConfig({ rootDir,  });
    const runtimeState = resolveRuntimeStateConfig({ rootDir, args, loadedConfig: loaded.config });
    const retention = resolveRetentionConfig(loaded.config);
    const result = await runRetentionCleanup({
      dataRoot: runtimeState.dataRoot,
      traceRoot: path.join(runtimeState.cacheRoot, 'traces'),
      settingsDatabasePath: runtimeState.settingsDatabasePath,
      retention,
      confirm: Boolean(args.confirm),
    });
    // Audits need the plan's truth, not thousands of candidate paths. Keeping
    // this projection opt-in preserves the detailed CLI/API plan for review.
    const output = args.summary
      ? {
        ok: result.ok,
        dryRun: result.dryRun,
        dataRoot: result.dataRoot,
        traceRoot: result.traceRoot,
        retention: result.retention,
        counts: result.counts,
        ...(result.deleted ? { deleted: { sessions: result.deleted.sessions.length, traces: result.deleted.traces.length } } : {}),
      }
      : result;
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  if (command === 'dream-memory') {
    const loaded = await loadBurrowConfig({ rootDir,  });
    const runtimeState = resolveRuntimeStateConfig({ rootDir, args, loadedConfig: loaded.config });
    const result = consolidateDreamMemory({ agentId: args.agent_id || 'hatchet', databasePath: runtimeState.settingsDatabasePath, limit: args.limit });
    if (args.json) return console.log(JSON.stringify(result, null, 2));
    console.log(`DreamMemory consolidated for ${result.agentId}: ${result.itemCount} item(s), ${result.document.markdown.length} chars.`);
    return;
  }

  if (command === 'dream-cycle') {
    const loaded = await loadBurrowConfig({ rootDir,  });
    const runtimeState = resolveRuntimeStateConfig({ rootDir, args, loadedConfig: loaded.config });
    const result = runDreamCycle({ agentId: args.agent_id || 'hatchet', databasePath: runtimeState.settingsDatabasePath, limit: args.limit });
    if (args.json) return console.log(JSON.stringify(result, null, 2));
    console.log(`Dream cycle completed for ${result.agentId}: ${result.phases.map((phase) => `${phase.phase}=${phase.inspected}`).join(', ')}; DreamMemory items=${result.dreamMemoryItemCount}.`);
    return;
  }

  if (command === 'review-proposal') {
    const proposalText = args.proposal_file
      ? await fs.readFile(args.proposal_file, 'utf8')
      : (args.message || args._.join(' '));
    if (!proposalText) throw new Error('--message or --proposal-file is required');
    const proposal = parseActionProposal(proposalText);
    const review = reviewProposalActions({ actions: proposal.actions, workspaceRoot: args.workspace_root || null });
    console.log(JSON.stringify({ ok: proposal.ok && review.ok, proposal, review }, null, 2));
    return;
  }

  const message = args.message || args._.join(' ');
  if (!message) throw new Error('--message is required');

  const loaded = await loadBurrowConfig({ rootDir,  });
  const defaults = configDefaults(loaded.config);
  const modelConfig = await resolveModelConfig(args, loaded.config);
  const executionConfig = resolveExecutionConfig(args, loaded.config);
  const contextConfig = resolveContextConfig(args, loaded.config);
  const skillsConfig = resolveSkillsConfig(loaded.config);
  const runtimeState = resolveRuntimeStateConfig({ rootDir, args, loadedConfig: loaded.config });

  if (command === 'ask' || command === 'chat') {
    const result = await runAskChat({
      rootDir,
      command,
      message,
      sessionId: args.session_id || args.run_id || 'default',
      runId: args.run_id,
      workspaceRoot: args.workspace_root || null,
      action: args.action || null,
      json: Boolean(args.json),
      noCallModel: Boolean(args.no_call_model),
      callModel: Boolean(args.call_model),
      args,
    });
    if (args.json) console.log(JSON.stringify(result, null, 2));
    else console.log(compactAskChatText(result));
    return;
  }

  if (command === 'run' || command === 'factory') {
    const factoryMode = command === 'factory';
    if (!factoryMode && !args.dry_run && !args.call_model) throw new Error('run requires --dry-run or --call-model');
    const maxTurns = factoryMode ? parsePositiveInt(args.max_turns, 1) : 1;
    const runOptions = {
      rootDir,
      mode: factoryMode || args.call_model ? 'model' : 'dry-run',
      runId: args.run_id || (factoryMode ? 'manual-factory' : 'manual-run'),
      workspaceRoot: args.workspace_root,
      files: args.file ? [args.file] : [],
      action: factoryMode ? (args.action || 'write') : (args.action || defaults.action || 'plan'),
      modelConfig,
      contextThreshold: contextConfig.contextThreshold,
      skillConfig: skillsConfig,
      verifyCommand: factoryMode ? await inferFactoryVerifyCommand({ workspaceRoot: args.workspace_root, explicitVerifyCommand: args.verify_command }) : args.verify_command,
      verifyCwd: args.verify_cwd || args.workspace_root,
      executeProposals: factoryMode ? true : executionConfig.executeProposals,
      allowReviewRequiredProposals: factoryMode ? true : executionConfig.allowReviewRequiredProposals,
      allowMutationProposals: factoryMode ? true : executionConfig.allowMutationProposals,
      commitChanges: factoryMode ? true : executionConfig.commitChanges,
      commitMessage: args.commit_message ?? executionConfig.commitMessage,
    };
    let factoryRun = null;
    if (factoryMode && !args.allow_dirty_worktree && args.workspace_root) {
      const dirtyBlock = await factoryDirtyWorktreeBlock({ rootDir, runId: runOptions.runId, workspaceRoot: args.workspace_root });
      if (dirtyBlock) factoryRun = { result: dirtyBlock, turns: [] };
    }
    if (!factoryRun && factoryMode && !args.allow_protected_branch && args.workspace_root) {
      const protectedBranchBlock = await factoryProtectedBranchBlock({ rootDir, runId: runOptions.runId, workspaceRoot: args.workspace_root });
      if (protectedBranchBlock) factoryRun = { result: protectedBranchBlock, turns: [] };
    }
    factoryRun ||= factoryMode && maxTurns > 1
      ? await runFactoryWithTurns({ maxTurns, message, runOptions })
      : { result: await runBurrow({ ...runOptions, message }), turns: [] };
    const result = factoryRun.result;
    if (factoryRun.turns.length) result.factoryTurns = factoryRun.turns;
    const compact = {
      ok: result.ok,
      mode: result.mode,
      decision: result.decision,
      blockers: result.blockers,
      warnings: result.warnings,
      selectedSkills: result.selectedSkills,
      promptChars: result.promptChars,
      promptSections: result.promptSections,
      runId: result.runId,
      traceDir: result.traceDir,
      modelOk: result.model?.ok ?? null,
      modelStatus: result.model?.status ?? null,
      answerText: result.answerText,
      modelTextChars: result.answerText?.length ?? 0,
      modelUsage: result.modelUsage,
      proposedActions: result.proposedActions ?? [],
      proposedActionCount: result.proposedActions?.length ?? 0,
      proposalOk: result.proposal?.ok ?? null,
      proposalErrors: result.proposal?.errors ?? [],
      proposalReview: result.proposalReview ?? null,
      proposalExecution: compactProposalExecution(result.proposalExecution),
      execution: factoryMode ? {
        ...executionConfig,
        profile: 'factory',
        executeProposals: true,
        allowReviewRequiredProposals: true,
        allowMutationProposals: true,
        commitChanges: true,
        commitMessage: args.commit_message ?? executionConfig.commitMessage,
        allowDirtyWorktree: Boolean(args.allow_dirty_worktree),
        allowProtectedBranch: Boolean(args.allow_protected_branch),
      } : executionConfig,
      commit: result.commit ? { ok: result.commit.ok, skipped: result.commit.skipped, reason: result.commit.reason, commitStdout: result.commit.commit?.stdout || null } : null,
      verification: result.verification ?? null,
      factoryTurns: factoryRun.turns,
      worktreeStatus: result.worktreeStatus,
      worktreeStatusCommandOk: result.worktreeStatusCommandOk,
      branch: result.branch,
    };
    console.log(JSON.stringify(args.json ? result : compact, null, 2));
    return;
  }

  const logger = createTraceLogger({ rootDir: resolveRuntimeTracePath({ ...runtimeState, sessionId: 'default' }), runId: args.run_id || defaults.runId || 'manual-plan' });
  const route = await routeRequest({
    rootDir,
    message,
    memoryContext: {},
    skillConfig: skillsConfig,
    workspaceContext: { workspaceRoot: args.workspace_root, files: args.file ? [args.file] : [] },
    action: args.action || null,
  });
  await logger.router({ stage: 'request-router', route });

  const policy = { ok: true, blockers: [], warnings: [], review: route.action?.review || null };

  const prompt = await assemblePrompt({
    rootDir,
    kernel: 'You are Hatchet. For direct questions about who or what you are, identify yourself as Hatchet and do not mention Burrow, the runtime, or the app unless the user explicitly asks about that product or runtime. Burrow is only the local runtime/app you operate through. Use routed skills and memory context only when provided.',
    selectedSkills: route.promptPlan.selectedSkills,
    modelProfile: null,
    task: message,
    traceLogger: logger,
  });

  const result = { runId: logger.runId, traceDir: logger.traceDir, route, policy, prompt };
  console.log(JSON.stringify(args.json ? result : compactPlan(result), null, 2));
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
