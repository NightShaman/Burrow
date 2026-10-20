#!/usr/bin/env node
/**
 * Repeatable, non-mutating prompt-composition evaluator.
 *
 * The evaluator gives the model inert tool schemas and records decisions. It
 * never executes requested tools. Credentials are read only from the process
 * environment and are never written to the report.
 */
import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { assemblePrompt } from '../src/prompt-assembler.mjs';
import { createOpenAICompatibleModelAdapter } from '../src/model-adapter.mjs';

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}
function integerArgument(name, fallback, { min = 1, max = 20 } = {}) {
  const value = Number(argument(name, fallback));
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be ${min}..${max}`);
  return value;
}
function listArgument(name, fallback) {
  return String(argument(name, fallback)).split(',').map(value => value.trim()).filter(Boolean);
}
function requiredEnvironment(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
function safeError(error) {
  return String(error?.message || error || 'evaluation_failed').replace(/(?:Bearer|Basic)\s+[^\s"']+/gi, '$1 [redacted]').slice(0, 1_000);
}
function tool(name, description, properties = {}) {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, additionalProperties: true } } };
}
const inertTools = [
  tool('inspect', 'Read-only inspection of relevant evidence.', { target: { type: 'string' } }),
  tool('push', 'Push already approved and committed source changes. Does not deploy.', { target: { type: 'string' } }),
  tool('mutate', 'Modify source or persistent state within the authorized task.', { target: { type: 'string' } }),
  tool('delegate_ui', 'Ask the established UI owner to perform bounded UI work.', { task: { type: 'string' } }),
];

function classify(result) {
  const calls = result?.choice?.toolCalls || [];
  return {
    text: String(result?.choice?.text || '').trim(),
    tools: calls.map(call => call.name),
    toolArguments: calls.map(call => call.arguments || {}),
    finishReason: result?.choice?.finishReason || null,
  };
}
function scoreExpectation(observed, expected = {}) {
  const tools = observed.tools || [];
  const uniqueTools = tools.filter((name, index) => tools.indexOf(name) === index);
  let decisionPass = true;
  if (Array.isArray(expected.toolsExactly) && JSON.stringify(uniqueTools) !== JSON.stringify(expected.toolsExactly)) decisionPass = false;
  if (Array.isArray(expected.toolsAnyOf) && !expected.toolsAnyOf.some(candidate => JSON.stringify(uniqueTools) === JSON.stringify(candidate))) decisionPass = false;
  if (Array.isArray(expected.forbidTools) && expected.forbidTools.some(name => uniqueTools.includes(name))) decisionPass = false;
  if (expected.textRequired === true && !observed.text) decisionPass = false;
  const normalizedText = String(observed.text || '').toLowerCase();
  if (Array.isArray(expected.textIncludesAny) && !expected.textIncludesAny.some(value => normalizedText.includes(String(value).toLowerCase()))) decisionPass = false;
  if (Array.isArray(expected.textIncludesAll) && !expected.textIncludesAll.every(value => normalizedText.includes(String(value).toLowerCase()))) decisionPass = false;
  if (Array.isArray(expected.textExcludes) && expected.textExcludes.some(value => normalizedText.includes(String(value).toLowerCase()))) decisionPass = false;
  const maxToolCalls = Number.isInteger(expected.maxToolCalls) ? expected.maxToolCalls : null;
  const efficiencyPass = maxToolCalls === null || tools.length <= maxToolCalls;
  return { decisionPass, efficiencyPass, pass: decisionPass && efficiencyPass, uniqueTools, redundantToolCalls: Math.max(0, tools.length - uniqueTools.length) };
}

const compositionKernelSuffixes = {
  'clarify-boundary-v1': 'Use conversation history to resolve clear references and established shorthand. Do not use it to invent a missing subject, complaint, or intended outcome. If multiple materially different interpretations remain, ask one concise clarifying question.',
};

export async function evaluatePromptBehavior({ fixture, adapter, repetitions = 3, compositions = ['legacy'], rootDir = process.cwd() }) {
  const results = [];
  for (const composition of compositions) {
    const kernelSuffix = compositionKernelSuffixes[composition] || '';
    const promptComposition = composition === 'clarify-boundary-v1' || composition === 'recent-history-v1' ? 'legacy' : composition;
    const baseConversation = composition === 'recent-history-v1'
      ? (fixture.baseConversation || []).slice(-12)
      : (fixture.baseConversation || []);
    for (const scenario of fixture.scenarios || []) {
      for (let repetition = 1; repetition <= repetitions; repetition += 1) {
        const startedAt = Date.now();
        try {
          const prompt = await assemblePrompt({
            rootDir,
            persistBuildTrace: false,
            kernel: [fixture.kernel || '', kernelSuffix].filter(Boolean).join('\n\n'),
            modelProfile: fixture.modelProfile || null,
            profileFiles: fixture.profileFiles || null,
            conversationContext: {
              recentMessages: [...baseConversation, ...(scenario.conversation || [])],
              priorSummary: scenario.priorSummary ?? fixture.basePriorSummary ?? '',
            },
            supportContext: scenario.supportContext || fixture.supportContext || null,
            availableSkills: fixture.availableSkills || [],
            task: scenario.message,
            composition: promptComposition,
          });
          const response = await adapter.complete({ messages: prompt.modelMessages, tools: inertTools, toolChoice: 'auto' });
          const observed = classify(response);
          const score = scoreExpectation(observed, scenario.expect);
          results.push({ composition, scenario: scenario.id, repetition, ok: true, ...score, durationMs: Date.now() - startedAt, observed });
        } catch (error) {
          results.push({ composition, scenario: scenario.id, repetition, ok: false, pass: false, durationMs: Date.now() - startedAt, error: safeError(error) });
        }
      }
    }
  }
  const summary = {};
  for (const result of results) {
    const key = result.composition;
    summary[key] ||= { runs: 0, passed: 0, failed: 0, decisionPassed: 0, efficiencyPassed: 0, redundantToolCalls: 0, errors: 0, scenarios: {} };
    const aggregate = summary[key];
    aggregate.runs += 1;
    if (result.pass) aggregate.passed += 1; else aggregate.failed += 1;
    if (result.decisionPass) aggregate.decisionPassed += 1;
    if (result.efficiencyPass) aggregate.efficiencyPassed += 1;
    aggregate.redundantToolCalls += Number(result.redundantToolCalls || 0);
    if (!result.ok) aggregate.errors += 1;
    aggregate.scenarios[result.scenario] ||= { runs: 0, passed: 0, decisionPassed: 0, efficiencyPassed: 0, redundantToolCalls: 0, toolChoices: {}, sampleTexts: [] };
    const scenario = aggregate.scenarios[result.scenario];
    scenario.runs += 1;
    if (result.pass) scenario.passed += 1;
    if (result.decisionPass) scenario.decisionPassed += 1;
    if (result.efficiencyPass) scenario.efficiencyPassed += 1;
    scenario.redundantToolCalls += Number(result.redundantToolCalls || 0);
    const choice = result.ok ? (result.observed.tools.join(',') || 'none') : 'error';
    scenario.toolChoices[choice] = (scenario.toolChoices[choice] || 0) + 1;
    if (result.observed?.text && scenario.sampleTexts.length < 2 && !scenario.sampleTexts.includes(result.observed.text)) scenario.sampleTexts.push(result.observed.text);
  }
  return { version: 1, generatedAt: new Date().toISOString(), model: fixture.model || null, reasoning: fixture.reasoning || null, repetitions, compositions, summary, results };
}

async function main() {
  const fixturePath = argument('--fixture');
  if (!fixturePath) throw new Error('--fixture is required');
  const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
  const repetitions = integerArgument('--repetitions', 3);
  const compositions = listArgument('--compositions', 'legacy');
  const baseUrl = argument('--base-url', process.env.CODEX_LB_BASE_URL || '');
  if (!baseUrl) throw new Error('--base-url or CODEX_LB_BASE_URL is required');
  const apiKey = requiredEnvironment('CODEX_LB_TOKEN');
  const model = argument('--model', fixture.model || 'gpt-5.6-sol');
  const reasoning = argument('--reasoning', fixture.reasoning || 'low');
  const adapter = createOpenAICompatibleModelAdapter({ config: { api: 'openai-responses', provider: 'Codex-LB', baseUrl, apiKey, model, extra: { reasoning: { effort: reasoning } } } });
  const report = await evaluatePromptBehavior({ fixture: { ...fixture, model, reasoning }, adapter, repetitions, compositions, rootDir: process.cwd() });
  const output = argument('--output');
  const rendered = `${JSON.stringify(report, null, 2)}\n`;
  if (output) await writeFile(output, rendered, { mode: 0o600 }); else process.stdout.write(rendered);
  if (report.results.some(result => !result.ok)) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(error => { console.error(safeError(error)); process.exitCode = 1; });
