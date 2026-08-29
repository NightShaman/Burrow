import { resolveRuntimeTraceRoot } from './config.mjs';
import { createTraceLogger } from './trace-logger.mjs';
import { loadSelectedSkillText } from './skill-catalog.mjs';
import { buildConversationContext } from './conversation-context.mjs';
import { conversationProviderMessages } from './provider-messages.mjs';
import { createHash } from 'node:crypto';
import path from 'node:path';

function clampText(value, maxChars) {
  const text = String(value || '').trim();
  if (!Number.isFinite(maxChars) || maxChars <= 0 || text.length <= maxChars) return text;
  const marker = `\n\n[truncated ${text.length - maxChars} chars]`;
  return `${text.slice(0, Math.max(0, maxChars - marker.length)).trim()}${marker}`;
}

function section(name, text, extra = {}) {
  const body = String(text || '').trim();
  return { name, text: body, chars: body.length, ...extra };
}

function sha256(value = '') {
  return createHash('sha256').update(String(value)).digest('hex');
}

function sourceForSection(name) {
  const sources = {
    kernel: 'runtime-kernel',
    'prompt-boundary': 'runtime-prompt-boundary',
    'profile-files': 'agent-profile-provider',
    profile: 'model-profile-provider',
    'action-output-contract': 'runtime-output-contract',
    conversation: 'conversation-provider',
    'prior-conversation-summary': 'conversation-provider',
    'support-session-recall': 'session-recall-provider',
    'relevant-run-evidence': 'run-evidence-provider',
    'support-dream-preload': 'dream-preload-provider',
    'support-operational-continuity': 'operational-continuity-provider',
    'support-working-context': 'working-context-provider',
    'active-ui-target': 'agent-context-provider',
    'verified-child-evidence': 'child-evidence-provider',
    'support-subagent': 'subagent-provider',
    'support-extra-eyes': 'extra-eyes-provider',
    attachment: 'attachment-provider',
    'attachment-manifest': 'attachment-manifest-provider',
    skills: 'skill-provider',
    'current-message': 'current-turn-provider',
    task: 'current-turn-provider',
  };
  return sources[name] || 'unknown-provider';
}

export function createContextBuildReceipt({ sections = [], text = '', stats = {} } = {}) {
  const includedSections = Array.isArray(sections) ? sections : [];
  return {
    version: 1,
    promptHash: sha256(text),
    totalChars: String(text).length,
    estimatedTokens: Math.ceil(String(text).length / 4),
    sections: includedSections.map((entry) => ({
      name: entry.name,
      source: sourceForSection(entry.name),
      chars: entry.chars,
      originalChars: entry.originalChars ?? entry.chars,
      includedChars: entry.chars,
      omitted: Boolean(entry.omitted || entry.omittedChars || entry.omittedItems?.length || entry.omittedFiles?.length),
      hash: sha256(entry.text),
      ...(entry.omittedChars ? { omittedChars: entry.omittedChars } : {}),
      ...(entry.items ? { includedItems: entry.items } : {}),
      ...(entry.omittedItems?.length ? { omittedItems: entry.omittedItems } : {}),
      ...(entry.files ? { files: entry.files } : {}),
      ...(entry.omittedFiles?.length ? { omittedFiles: entry.omittedFiles } : {}),
      ...(entry.attachment ? { attachment: entry.attachment } : {}),
    })),
    sources: {
      skills: stats.skillProvenance || [],
      attachments: stats.attachments || [],
      // Compatibility aggregate plus truthful per-turn provenance.
      attachmentManifest: stats.attachmentManifest || [],
      retainedAttachmentManifest: stats.retainedAttachmentManifest || [],
      currentAttachmentManifest: stats.currentAttachmentManifest || [],
      conversation: stats.conversation || null,
    },
  };
}

function renderProfileFileBlock(file = {}) {
  return [`## ${file.name || 'profile file'}`, `Path: ${file.path || 'unknown'}`, '', String(file.content || '').trim()].join('\n');
}

function renderProfileFilesBudgeted(profileFiles = null, { totalBudget = 8_000, perFileBudget = 4_000 } = {}) {
  const files = profileFiles?.files || [];
  if (!files.length) return { text: '', included: [], omitted: [], usedChars: 0 };
  const blocks = ['Editable Burrow profile files. These shape voice, preferences, product framing, and environment facts. Runtime safety/evidence gates still override when they conflict.'];
  const included = [];
  const omitted = [];
  let used = blocks[0].length;
  for (const file of files) {
    const rendered = renderProfileFileBlock(file);
    const remaining = Math.max(0, totalBudget - used);
    const budget = Math.max(0, Math.min(perFileBudget, remaining));
    const body = budget > 0 ? clampText(rendered, budget) : '';
    const record = { name: file.name, path: file.path || null, originalChars: rendered.length, includedChars: body.length, omittedChars: Math.max(0, rendered.length - body.length), included: Boolean(body) };
    if (!body) { omitted.push(record); continue; }
    included.push(record);
    blocks.push(body);
    used += body.length;
  }
  return { text: blocks.join('\n\n---\n\n'), included, omitted, usedChars: used };
}

function renderAttachmentManifest(attachments = [], { artifactRoot = null } = {}) {
  const items = Array.isArray(attachments) ? attachments : [];
  if (!items.length) return '';
  const lines = [
    'Retained attachment manifest. These are lightweight local references to prior/current attachments, not attachment bytes or image content. Reopen a referenced artifact only when needed.',
  ];
  for (const item of items.slice(-24)) {
    const parts = [
      `- ${String(item?.name || 'attachment')}`,
      `type=${String(item?.type || item?.mimeType || 'application/octet-stream')}`,
      item?.size !== null && item?.size !== undefined ? `size=${Number(item.size)}` : null,
      item?.artifactPath ? `artifact=${String(item.artifactPath)}` : null,
      item?.artifactPath && artifactRoot ? `reopen=${path.resolve(artifactRoot, String(item.artifactPath))}` : null,
      item?.storedAt ? `storedAt=${String(item.storedAt)}` : null,
      item?.runId ? `run=${String(item.runId)}` : null,
    ].filter(Boolean);
    lines.push(parts.join(' · '));
  }
  return lines.join('\n');
}

function renderAttachmentSections(attachments = [], { totalBudget = 32_000, perFileBudget = 12_000 } = {}) {
  const files = Array.isArray(attachments) ? attachments : [];
  const sections = [];
  const provenance = [];
  let used = 0;
  for (const attachment of files) {
    const name = String(attachment?.name || `attachment-${provenance.length + 1}`);
    const type = String(attachment?.type || attachment?.mimeType || 'text/plain');
    const encoding = String(attachment?.encoding || 'utf8');
    const originalText = String(attachment?.text ?? attachment?.content ?? '');
    const remaining = Math.max(0, totalBudget - used);
    const budget = Math.max(0, Math.min(perFileBudget, remaining));
    const included = budget > 0 ? clampText(originalText, budget) : '';
    const omitted = originalText.length - included.length;
    provenance.push({
      name,
      type,
      encoding,
      originalChars: originalText.length,
      includedChars: included.length,
      omittedChars: Math.max(0, omitted),
      included: Boolean(included),
    });
    if (!included) continue;
    used += included.length;
    sections.push(section('attachment', [`Attachment: ${name}`, `Type: ${type}`, `Encoding: ${encoding}`, `Original chars: ${originalText.length}`, `Included chars: ${included.length}`, originalText.length > included.length ? `Truncation: ${originalText.length - included.length} chars omitted from this attachment.` : '', '', included].filter(Boolean).join('\n'), { attachment: provenance.at(-1) }));
  }
  return { sections, provenance, usedChars: used };
}

function renderSkill(skill) {
  return `## Skill: ${skill.id}
Path: ${skill.path}
Source type: ${skill.sourceType || 'unknown'}
Version: ${skill.version || 'unknown'}
Lifecycle: ${skill.lifecycle || 'active'}
Prompt inclusion: ${skill.promptInclusion || 'selected'}
Relevance selection: ${(skill.reasons || []).join(', ') || skill.selection?.source || 'not selected'}

${skill.content}`;
}

function renderExtraEyesReview(review = null) {
  if (!review) return '';
  const result = review.result || review.record?.result || {};
  const lines = [
    'Parent-directed extra-eyes review. Treat this as support evidence gathered at the parent turn\'s request; the parent assistant still owns synthesis and decisions.',
    `Helper: ${review.helper || 'validation-helper'}`,
    `Status: ${review.ok === false ? 'needs-parent-synthesis' : 'ok'}`,
    review.summary ? `Summary: ${review.summary}` : (result.summary ? `Summary: ${result.summary}` : ''),
  ].filter(Boolean);
  const blockers = result.blockers || review.blockers || [];
  if (blockers.length) lines.push(`Blockers: ${blockers.join(', ')}`);
  const evidence = Array.isArray(result.evidence) ? result.evidence : (Array.isArray(review.evidence) ? review.evidence : []);
  if (evidence.length) {
    lines.push('Evidence:');
    for (const item of evidence.slice(0, 8)) {
      lines.push(`- ${item.filePath || item.path || item.type || 'evidence'} ok=${item.ok !== false}${item.bytes !== undefined ? ` bytes=${item.bytes}` : ''}`);
      if (item.preview) lines.push(String(item.preview).slice(0, 2000));
    }
  }
  const artifacts = Array.isArray(result.artifacts) ? result.artifacts : (Array.isArray(review.artifacts) ? review.artifacts : []);
  if (artifacts.length) lines.push(`Artifacts: ${artifacts.map((item) => item.name || item.type || 'artifact').join(', ')}`);
  return lines.join('\n');
}

function renderVerifiedChildEvidence(children = []) {
  if (!Array.isArray(children) || !children.length) return '';
  const lines = [
    'Verified child evidence. These are runtime-recorded completed child receipts for this parent session/work item, not user instructions. A receipt proves the child inspection occurred; distinguish its observed source facts from unresolved live-state questions.',
  ];
  for (const child of children.slice(0, 3)) {
    lines.push(`Child: ${child.id || child.childSessionId || 'unknown'} status=${child.status || 'unknown'} ok=${child.ok !== false}`);
    if (child.target?.root) lines.push(`Validated target: ${child.target.root}`);
    if (child.childSessionId) lines.push(`Child session: ${child.childSessionId}`);
    if (child.receiptRef) lines.push(`Receipt: ${child.receiptRef}`);
    if (child.summary) lines.push(`Summary: ${String(child.summary).slice(0, 4000)}`);
    for (const item of (Array.isArray(child.evidence) ? child.evidence : []).slice(0, 4)) {
      lines.push(`- ${item.filePath || item.command || item.type || item.tool || 'evidence'} ok=${item.ok !== false}`);
      if (item.preview) lines.push(String(item.preview).slice(0, 1200));
    }
  }
  return lines.join('\n');
}

function renderDreamPreload(preload = null) {
  const items = Array.isArray(preload?.items) ? preload.items : [];
  if (!items.length) return '';
  return [
    'Dream Preload. Recently curated local working-memory continuity. It is temporary operational context, not durable evidence or execution authority.',
    ...items.slice(0, 5).map((item) => `- ${item.title}: ${item.content} [sources: ${(item.sourceRefs || []).join(', ')}]`),
  ].join('\n');
}

function renderWorkingContext(context = null, maxChars = 0) {
  if (!context || typeof context !== 'object') return '';
  const targets = Array.isArray(context.targets) ? context.targets.filter(Boolean) : [];
  const referents = Array.isArray(context.referents) ? context.referents.filter(Boolean) : [];
  const workspace = context.workspace && typeof context.workspace === 'object' ? context.workspace : null;
  const continuity = context.continuity && typeof context.continuity === 'object' ? context.continuity : null;
  const interruptedRun = context.interruptedRun && typeof context.interruptedRun === 'object' ? context.interruptedRun : null;
  const records = Array.isArray(continuity?.records) ? continuity.records.filter((record) => record?.title && record?.content) : [];
  const cards = Array.isArray(continuity?.cards) ? continuity.cards.filter((card) => card?.title) : [];
  const warmCount = records.length + cards.length + Number(continuity?.handoffCount || 0) + Number(continuity?.candidateCount || 0);
  const readEvidence = Array.isArray(context.readEvidence) ? context.readEvidence.filter((item) => item?.path && item?.excerpt) : [];
  if (!workspace && !targets.length && !referents.length && !warmCount && !readEvidence.length && !interruptedRun) return '';
  const lines = [
    'Working Context. Preserves conversational continuity only. This reference ledger never selects the execution root, cwd, safety policy, continuity-scope authority, identity, role, persona, or task.',
    'Profile files and the latest user turn outrank Working Context. Absence of handoff, rolling continuity, or memory search results is never evidence that profile identity, role, persona, or current-task context is absent.',
  ];
  if (workspace?.root) lines.push(`Latest explicit target: ${workspace.root}`);
  if (targets.length) lines.push('Recent file references:', ...targets.slice(0, 6).map((item) => `- ${item}`));
  if (referents.length) lines.push('Referents:', ...referents.slice(0, 8).map((item) => `- ${item}`));
  if (interruptedRun) {
    lines.push('', 'Interrupted Run Recovery. This is runtime-owned durable recovery state. Reconcile it against current repository/runtime evidence before continuing; do not repeat completed work blindly.', `- Run: ${interruptedRun.runId || 'unknown'} (generation ${interruptedRun.generation ?? 'unknown'})`, `- Reason: ${interruptedRun.reason || 'unknown'}`);
    if (interruptedRun.objective) lines.push(`- Authorized objective: ${interruptedRun.objective}`);
    if (interruptedRun.lastCompletedStep) lines.push(`- Last durable state: ${interruptedRun.lastCompletedStep}`);
    if (interruptedRun.changedFiles?.length) lines.push('- Changed files:', ...interruptedRun.changedFiles.slice(0, 12).map((item) => `  - ${item}`));
    if (interruptedRun.pendingVerification?.length) lines.push('- Pending reconciliation:', ...interruptedRun.pendingVerification.slice(0, 8).map((item) => `  - ${item}`));
  }
  if (readEvidence.length) {
    const preamble = 'Retained ReadEvidence. Exact excerpts returned by earlier files_read calls. They are version-checked before use; this request includes only the evidence that fits its context budget. Reopen the file when you need content outside an included excerpt.';
    // No independent working-context default: this receives its allocation from
    // the request-level context budget calculated by ContextBuilder. Do not
    // claim ReadEvidence was retained unless at least one excerpt can follow.
    let remaining = Math.max(0, Number(maxChars) || 0) - lines.join('\n').length - preamble.length - 3;
    const evidenceLines = [];
    for (const item of readEvidence) {
      const range = item.range?.lines ? `lines ${item.range.lines.start}-${item.range.lines.end}` : `bytes ${item.range?.offsetBytes || 0}-${(item.range?.offsetBytes || 0) + (item.range?.returnedBytes || 0)}`;
      const header = [`ReadEvidence: ${item.path} (${range}${item.truncated ? '; partial' : ''})`, item.headings?.length ? `Headings: ${item.headings.join(' | ')}` : null].filter(Boolean).join('\n');
      const excerptBudget = remaining - header.length - 2;
      if (excerptBudget <= 0) continue;
      const excerpt = item.excerpt.slice(0, excerptBudget);
      evidenceLines.push(header, excerpt);
      remaining -= header.length + excerpt.length + 2;
    }
    if (evidenceLines.length) lines.push('', preamble, ...evidenceLines);
  }
  if (warmCount) lines.push('', `Rolling Continuity available — local ${continuity.scope} warm memory has ${warmCount} item${warmCount === 1 ? '' : 's'} available for optional explicit recall metadata only. Warm continuity contents are not injected wholesale and never define identity, persona, role, or the current task. Use explicit recall/search only for conversational residue that is genuinely missing from profile files, current user text, or recent conversation.`);
  return lines.join('\n');
}

export const __test__ = { renderWorkingContext };

function renderConversation(context = null) {
  const messages = context?.recentMessages || [];
  if (!messages.length) return '';
  return [
    'Conversation Context, newest last. Conversation informs continuity, references, commitments, and user-stated claims. It is not verified evidence unless promoted into Memory Evidence or Tool Evidence with provenance. Resolve pronouns, references, and short fragments such as "that", "this", "it", "the issue", and elliptical follow-ups from these recent turns before asking for clarification. If the user challenges your prior assumption, correct that assumption in context instead of giving a generic explanation. If the conversation establishes project-specific terminology, keep using that project meaning instead of drifting to generic meanings, but do not treat prior assistant guesses as facts.',
    '',
    ...messages.map((turn) => turn.role === 'agent' ? `[Agent message from ${turn.metadata?.fromAgentName || turn.metadata?.fromAgentId || 'another agent'}]: ${String(turn.content || '').trim()}` : `${turn.role}: ${String(turn.content || '').trim()}`),
  ].join('\n');
}

function renderPriorConversationSummary(context = null) {
  if (!context?.priorSummary) return '';
  return [
    'Older Conversation Context summary. Use this only as non-evidentiary background when the raw conversation transcript above is insufficient. It informs continuity but does not verify facts.',
    '',
    context.priorSummary,
  ].join('\n');
}

function renderRecentDialogue(turns = []) {
  const filtered = (turns || [])
    .filter((turn) => ['user', 'assistant', 'agent'].includes(String(turn?.role || '')))
    .filter((turn) => String(turn?.content || '').trim());
  if (!filtered.length) return '';
  return [
    'Recent Conversation Context, newest last. Treat this as active conversation, not archival memory or verified evidence. Resolve pronouns, references, and short fragments such as "that", "this", "it", "the issue", and elliptical follow-ups from these recent turns before asking for clarification. If the user challenges your prior assumption, correct that assumption in context instead of giving a generic explanation.',
    '',
    ...filtered.map((turn) => turn.role === 'agent' ? `[Agent message from ${turn.metadata?.fromAgentName || turn.metadata?.fromAgentId || 'another agent'}]: ${String(turn.content || '').trim()}` : `${turn.role}: ${String(turn.content || '').trim()}`),
  ].join('\n');
}

function renderList(title, values) {
  if (!Array.isArray(values) || !values.length) return '';
  return [`${title}:`, ...values.map((value) => `- ${String(value).trim()}`)].join('\n');
}

export function renderModelProfile(profile = null) {
  if (!profile || typeof profile !== 'object') return '';
  const parts = [];
  if (profile.identity) parts.push(`Identity: ${String(profile.identity).trim()}`);
  if (profile.voice) parts.push(`Voice: ${String(profile.voice).trim()}`);
  if (profile.personality) parts.push(`Personality: ${String(profile.personality).trim()}`);
  if (profile.responseStyle) parts.push(`Response style: ${String(profile.responseStyle).trim()}`);
  const rules = renderList('Rules', profile.rules);
  if (rules) parts.push(rules);
  const projectBehavior = renderList('Project behavior', profile.projectBehavior);
  if (projectBehavior) parts.push(projectBehavior);
  return parts.join('\n\n');
}

function renderActionProposalContract() {
  return `When you can answer without tools, return plain text.
When you want Burrow to inspect, check, write, patch, or run commands, return exactly one JSON object and no surrounding prose:

{
  "answer": "short human-readable summary",
  "actions": [
    { "tool": "files_read", "filePath": "/absolute/or/workspace/path" },
    { "tool": "shell_exec", "command": "npm run check" },
    { "tool": "files_write", "filePath": "/absolute/or/workspace/path", "content": "complete file content" },
    { "tool": "files_patch", "patch": "unified diff patch text" },
    { "tool": "spawn_subagent", "task": "inspect the module", "target": { "kind": "filesystem", "root": "/absolute/path" } }
  ]
}

Action rules:
- Use only these tools: shell_exec, files_read, files_write, files_patch, spawn_subagent.
- Prefer proposing files_read and safe check shell_exec actions before mutation.
- For repository/source inspection, inspect source-bearing files and directories first: package.json, README files, docs, src, scripts, tests, app, pages, components, public, config files, and build files.
- Do not let runtime artifact directories masquerade as the project source. Exclude traces, sessions, work-items, handoffs, memory, profile, skills, tools, artifacts, workbench-verify, node_modules, .git, coverage, dist, build, .cache, and tmp from broad file listings unless the user explicitly asks about those artifacts.
- Avoid broad listings like "find . ... | head" that can be dominated by runtime artifacts. Use targeted listings or exclude artifact directories before truncating.
- Read-only file inspection may use absolute paths outside the workspace when the user asks about a specific local path or when needed to answer. Do not pretend workspaceRoot is the entire visible filesystem.
- For mutations, act only on an explicit target/scope and include a safe check action such as npm run check, node --check, git diff, or test ... when possible. WorkspaceRoot is default context, not the whole authority boundary; explicit absolute paths are valid local targets when the user asks for them.
- files_write content must be the full intended file content, not a partial snippet.
- files_patch patch must be a valid unified diff. Prefer paths relative to the active base context when possible; explicit absolute/outside-workspace targets are handled by execution review and audit metadata, not by pretending the workspace is the whole filesystem.
- spawn_subagent is only for explicit selected child-agent work. It requires a structural target with target.kind exactly "filesystem" and target.root as an absolute existing directory. Do not use repository, repo, directory, folder, or project as target.kind. It runs an isolated child model/tool loop.`;
}

function renderUiTarget(target = null) {
  if (!target?.url) return '';
  return `Active UI target${target.label ? ` (${target.label})` : ''}: ${target.url}\nUse the granted browser tools to open or select this target when visual inspection, browser debugging, or UI validation is needed. This is the current target; do not assume a fixed dev-server port.`;
}

function renderGroupChannel(group = null) {
  if (!group?.channelId || !Array.isArray(group.turns) || !group.turns.length) return '';
  const lines = group.turns.slice(-80).map((turn) => {
    const metadata = turn.metadata || {};
    const speaker = turn.role === 'user'
      ? 'Operator'
      : metadata.fromAgentName || metadata.fromAgentId || turn.role || 'Participant';
    return `[${speaker}] ${String(turn.content || '').trim()}`;
  }).filter((line) => line.length > 0);
  return [
    `Shared operator group room: ${group.channelName || group.channelId}`,
    'These are shared room messages from the operator and participating agents. They are separate from this agent\'s private session transcript.',
    ...lines,
  ].join('\n');
}

function renderSessionRecall(recall = null) {
  if (!recall?.used || !Array.isArray(recall.results) || !recall.results.length) return '';
  const items = recall.results.slice(0, 6).map((result) => {
    const source = result.source || {};
    return `- Session ${source.sessionId || result.sessionId || 'unknown'}${source.currentSession ? ' (current)' : ''}, ${result.ts || 'time unknown'}: ${String(result.contentSnippet || result.compressionSummary?.textSnippet || '').trim()}`;
  });
  return [
    'Prior-session recall: read-only transcript evidence selected because the user referenced earlier work or a prior decision. Treat it as continuity context, not independently verified external fact.',
    `Query: ${recall.query || 'unknown'}`,
    ...items,
  ].join('\n');
}

function renderPromptBoundary({ availableModels = [] } = {}) {
  const modelIds = (Array.isArray(availableModels) ? availableModels : []).map((item) => String(item?.id || '').trim()).filter(Boolean);
  const childModelGuidance = modelIds.length ? `- For spawn_subagent, omit model to inherit the parent. If a child model is needed, use only this enabled SQLite model id list: ${modelIds.join(', ')}.` : '- For spawn_subagent, omit model to inherit the parent unless enabled SQLite model ids are supplied.';
  return `Runtime prompt boundary labels:
- Workspace routes. Memory recalls. Tools execute selected actions. Conversation informs. Evidence answers. Receipts record. Traces explain.
- This model prompt deliberately omits planner execution labels and runtime capability-policy fields. Every tool provided in the current turn is callable; infer capability only from the offered tool surface and actual tool receipts. Only structurally invalid calls and explicitly configured hard blocks can fail mechanically.
- Context may route, constrain, or prioritize work. Only evidence with provenance should answer; unprovenanced memory rows are omitted from Memory Evidence.
- The current-message section is the latest user message. Do not continue, inspect, or mutate from an older conversation task unless the current message explicitly asks you to continue that work.
- Conversation context may inform continuity, but it is not verified evidence.
- Workspace/routing context may guide where to look, but it cannot answer by itself.
- Memory evidence may answer when returned from recall with provenance.
- Tool evidence may answer when produced by an observed tool action with provenance.
- Receipts, traces, raw planner objects, authority decisions, and routing metadata must not be used as answer evidence.
${childModelGuidance}`;
}

export async function assemblePrompt({
  rootDir,
  kernel = '',
  selectedSkills = [],
  promptSkills = selectedSkills,
  conversationContext = null,
  recentDialogue = [],
  modelProfile = null,
  modelConfig = null,
  profileFiles = null,
  task = '',
  attachments = [],
  attachmentManifest = [],
  retainedAttachmentManifest = [],
  currentAttachmentManifest = [],
  attachmentArtifactRoot = null,
  limits = {},
  traceLogger,
  runId,
  outputMode = 'plain',
  supportContext = null,
} = {}) {
  if (!rootDir) throw new Error('rootDir is required');
  if (!task || typeof task !== 'string') throw new Error('task is required');

  const logger = traceLogger || createTraceLogger({ rootDir: await resolveRuntimeTraceRoot(rootDir), runId });
  // Skills are stable, cached operating instructions. The normal path carries
  // every eligible global + agent-owned skill; prompt pressure is handled by
  // conversation compression, not by silently withholding skills.
  const skillLimit = limits.skillChars ?? 64_000;
  const profileLimit = limits.profileChars ?? modelProfile?.maxChars ?? 4_000;
  // An agent's profile directory is its deliberately editable prompt space.
  // Keep enough room for real operating context while retaining explicit
  // provenance and deterministic truncation if someone overfills it.
  const profileFilesLimit = limits.profileFilesChars ?? 50_000;
  const profileFilePerFileLimit = limits.profileFileChars ?? 50_000;
  const kernelLimit = limits.kernelChars ?? 4_000;
  const taskLimit = limits.taskChars ?? 8_000;
  const attachmentBudget = limits.attachmentChars ?? 32_000;
  const attachmentPerFileBudget = limits.attachmentPerFileChars ?? 12_000;

  const loadedSkills = await loadSelectedSkillText(rootDir, promptSkills, { maxTotalChars: skillLimit, maxPerSkillChars: skillLimit });
  const skillTexts = [];
  let omittedSkillChars = 0;
  let usedSkillChars = 0;

  for (const skill of loadedSkills) {
    if (skill.missing || !skill.content) {
      omittedSkillChars += 0;
      continue;
    }
    const rendered = renderSkill(skill);
    if (usedSkillChars + rendered.length > skillLimit) {
      omittedSkillChars += rendered.length;
      continue;
    }
    skillTexts.push(rendered);
    usedSkillChars += rendered.length;
  }

  const loadedSkillIds = loadedSkills
    .filter((skill) => !skill.missing && skillTexts.some((text) => text.includes(`## Skill: ${skill.id}\n`)))
    .map((skill) => skill.id);
  const omittedSkillIds = loadedSkills
    .filter((skill) => skill.missing || !loadedSkillIds.includes(skill.id))
    .map((skill) => skill.id);
  const skillProvenance = loadedSkills.map((skill) => ({
    id: skill.id,
    path: skill.path || skill.sourcePath || null,
    sourceType: skill.sourceType || null,
    owner: skill.owner || null,
    ownership: skill.ownership || null,
    version: skill.version || null,
    lifecycle: skill.missing ? 'missing' : skill.lifecycle || 'available',
    loaded: loadedSkillIds.includes(skill.id),
    selectionSource: skill.selection?.source || null,
    reasons: skill.reasons || [],
  }));

  const hasPreparedConversation = Boolean(conversationContext && typeof conversationContext === 'object');
  // ContextEngine owns conversation retention. A prepared conversation has
  // already been selected under the effective model budget, so rendering must
  // not apply a second independent character cap here.
  const conversation = conversationContext || buildConversationContext({ transcript: recentDialogue, limits: { rawRecentChars: limits.conversationChars ?? limits.recentDialogueChars ?? 6_000, priorSummaryChars: limits.priorSummaryChars ?? 4_000 } });
  const renderedConversation = hasPreparedConversation
    ? renderConversation(conversation)
    : clampText(renderConversation(conversation), limits.conversationChars ?? limits.recentDialogueChars ?? 6_000);
  const renderedAttachments = renderAttachmentSections(attachments, { totalBudget: attachmentBudget, perFileBudget: attachmentPerFileBudget });
  // `attachmentManifest` remains a compatibility input. Normal runtime
  // callers provide the two provenance-preserving lists below.
  const retainedManifest = Array.isArray(retainedAttachmentManifest) && retainedAttachmentManifest.length
    ? retainedAttachmentManifest : attachmentManifest;
  const currentManifest = Array.isArray(currentAttachmentManifest) ? currentAttachmentManifest : [];
  const renderedAttachmentManifest = renderAttachmentManifest([...retainedManifest, ...currentManifest], { artifactRoot: attachmentArtifactRoot });
  const renderedProfileFiles = renderProfileFilesBudgeted(profileFiles, { totalBudget: profileFilesLimit, perFileBudget: profileFilePerFileLimit });

  const rawSections = [
    section('kernel', clampText(kernel, kernelLimit)),
    section('prompt-boundary', renderPromptBoundary({ availableModels: modelConfig?.availableModels || [] })),
    section('profile-files', renderedProfileFiles.text, {
      items: renderedProfileFiles.included.map((file) => file.name),
      omittedItems: renderedProfileFiles.omitted.map((file) => file.name),
      files: renderedProfileFiles.included,
      omittedFiles: renderedProfileFiles.omitted,
    }),
    section('profile', clampText(renderModelProfile(modelProfile), profileLimit)),
    section('action-output-contract', outputMode === 'proposal' ? renderActionProposalContract() : ''),
    section('conversation', renderedConversation),
    section('prior-conversation-summary', clampText(renderPriorConversationSummary(conversation), limits.priorSummaryChars ?? 4_000)),
    section('support-group-channel', clampText(renderGroupChannel(supportContext?.groupChannel || null), limits.groupChannelChars ?? 12_000)),
    section('support-session-recall', clampText(renderSessionRecall(supportContext?.sessionRecall || null), limits.sessionRecallChars ?? 6_000)),
    section('relevant-run-evidence', clampText(supportContext?.runEvidence?.text || '', limits.runEvidenceChars ?? 6_000)),
    section('support-dream-preload', clampText(renderDreamPreload(supportContext?.dreamPreload || null), limits.dreamPreloadChars ?? 2_000)),
    section('support-working-context', renderWorkingContext(supportContext?.workingContext || null, limits.workingContextChars ?? 0)),
    section('active-ui-target', clampText(renderUiTarget(supportContext?.uiTarget || null), limits.uiTargetChars ?? 2_500)),
    section('verified-child-evidence', clampText(renderVerifiedChildEvidence(supportContext?.childEvidence || []), limits.childEvidenceChars ?? 10_000)),
    section('support-extra-eyes', clampText(renderExtraEyesReview(supportContext?.extraEyesReview || null), limits.extraEyesChars ?? 6_000)),
    section('attachment-manifest', renderedAttachmentManifest, { items: (Array.isArray(attachmentManifest) ? attachmentManifest : []).slice(-24).map((item) => ({ name: item?.name || 'attachment', type: item?.type || item?.mimeType || 'application/octet-stream', artifactPath: item?.artifactPath || null })) }),
    ...renderedAttachments.sections,
    section('skills', skillTexts.join('\n\n---\n\n'), {
      items: loadedSkillIds,
      omittedItems: omittedSkillIds,
      omittedChars: omittedSkillChars,
    }),
    section('current-message', clampText(task, taskLimit)),
  ];
  const sections = rawSections.filter((item) => item.text);

  const text = sections.map((item) => `# ${item.name}\n\n${item.text}`).join('\n\n---\n\n');
  // Retain the legacy flattened prompt for receipts and older callers, but
  // expose a provider-ready split whose first message is stable across turns.
  const staticSectionNames = new Set(['kernel', 'prompt-boundary', 'profile-files', 'profile', 'skills']);
  const staticSections = sections.filter((item) => staticSectionNames.has(item.name));
  const volatileSections = sections.filter((item) => !staticSectionNames.has(item.name));
  const renderSections = (items) => items.map((item) => `# ${item.name}\n\n${item.text}`).join('\n\n---\n\n');
  // Keep configured identity in its own first-class system message. Providers
  // may cache or reason over this boundary differently from operating
  // instructions; never make profile documents share a block with volatile
  // prompt guidance merely because both are system-authored.
  const identitySectionNames = new Set(['profile-files', 'profile']);
  const identitySections = staticSections.filter((item) => identitySectionNames.has(item.name));
  const operatingSections = staticSections.filter((item) => !identitySectionNames.has(item.name));
  const conversationSectionNames = new Set(['conversation', 'prior-conversation-summary', 'current-message', 'task']);
  const supportSections = volatileSections.filter((item) => !conversationSectionNames.has(item.name));
  const modelMessages = [
    ...(identitySections.length ? [{ role: 'system', content: renderSections(identitySections), metadata: { providerMessageSource: 'agent-identity-provider' } }] : []),
    ...(operatingSections.length ? [{ role: 'system', content: renderSections(operatingSections), metadata: { providerMessageSource: 'stable-instructions-provider' } }] : []),
    ...(supportSections.length ? [{
      role: 'user',
      content: renderSections(supportSections),
      metadata: { providerMessageSource: 'support-context-provider' },
    }] : []),
    ...conversationProviderMessages({
      priorSummary: renderPriorConversationSummary(conversation),
      recentMessages: conversation.recentMessages || [],
      task: clampText(task, taskLimit),
    }),
  ];
  const conversationSection = rawSections.find((item) => item.name === 'conversation');
  const priorSummarySection = rawSections.find((item) => item.name === 'prior-conversation-summary');
  const profileSection = rawSections.find((item) => item.name === 'profile');
  const profileFilesSection = rawSections.find((item) => item.name === 'profile-files');
  const stats = {
    totalChars: text.length,
    sections: sections.map(({ name, chars }) => ({ name, chars })),
    selectedSkills: selectedSkills.map((skill) => skill.id),
    promptEligibleSkills: promptSkills.map((skill) => skill.id),
    loadedSkills: loadedSkillIds,
    omittedSkills: omittedSkillIds,
    skillProvenance,
    conversationChars: conversationSection?.chars || 0,
    recentDialogueChars: conversationSection?.chars || 0,
    priorConversationSummaryChars: priorSummarySection?.chars || 0,
    conversation: conversation?.stats || null,
    profileChars: profileSection?.chars || 0,
    profileFilesChars: profileFilesSection?.chars || 0,
    profileFiles: profileFilesSection?.items || [],
    omittedProfileFiles: profileFilesSection?.omittedItems || [],
    profileFileProvenance: profileFilesSection?.files || [],
    omittedProfileFileProvenance: profileFilesSection?.omittedFiles || [],
    attachments: renderedAttachments.provenance,
    attachmentManifest: [...retainedManifest, ...currentManifest].slice(-24).map((item) => ({
      name: String(item?.name || 'attachment'),
      type: String(item?.type || item?.mimeType || 'application/octet-stream'),
      size: Number.isFinite(Number(item?.size)) ? Number(item.size) : null,
      ...(item?.artifactPath ? { artifactPath: String(item.artifactPath) } : {}),
      ...(item?.storedAt ? { storedAt: String(item.storedAt) } : {}),
      ...(item?.runId ? { runId: String(item.runId) } : {}),
    })),
    retainedAttachmentManifest: retainedManifest.slice(-24).map((item) => ({ ...item })),
    currentAttachmentManifest: currentManifest.slice(-24).map((item) => ({ ...item })),
    attachmentChars: renderedAttachments.usedChars,
  };

  const contextBuildReceipt = createContextBuildReceipt({ sections, text, stats });
  const result = { text, sections, modelMessages, stats, contextBuildReceipt };
  await logger.router({
    stage: 'context-build',
    selectedSkills: stats.selectedSkills,
    promptEligibleSkills: stats.promptEligibleSkills,
    loadedSkills: stats.loadedSkills,
    omittedSkills: stats.omittedSkills,
    skillProvenance: stats.skillProvenance,
    totalChars: stats.totalChars,
    sections: stats.sections,
    contextBuildReceipt,
  });
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rootDir = process.argv[2] || process.cwd();
  const task = process.argv.slice(3).join(' ');
  const result = await assemblePrompt({ rootDir, task, kernel: 'You are Hatchet.' });
  console.log(JSON.stringify(result.stats, null, 2));
}
