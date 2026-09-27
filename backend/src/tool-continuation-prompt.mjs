import { compactToolCalls, stableJson } from './tool-loop-detection.mjs';
import { serializeContinuationEvidence } from './continuation-evidence.mjs';
import { nativeToolSchemas } from './action-proposal.mjs';

function compactSkippedToolActions(skipped = []) {
  return (skipped || []).map((item) => ({
    index: item.index ?? null,
    tool: item.tool || null,
    status: item.status || 'not_executed',
  }));
}

function skippedToolSummary(skipped = []) {
  const compact = compactSkippedToolActions(skipped);
  if (!compact.length) return '';
  return compact.map((item) => `- NOT EXECUTED: ${item.tool || 'tool'}${item.index === null ? '' : ` #${item.index}`} (${item.status})`).join('\n');
}

function executedToolResultPrompt({ basePrompt = '', message = '', toolResults = [], skipped = [], toolCalls = [], iteration = 1, runtimeNotice = null, modelConfig = null, contextThreshold = null } = {}) {
  const callSummary = compactToolCalls(toolCalls).map((call) => `${call.name} ${stableJson(call.arguments)}`).join('\n');
  const skippedSummary = skippedToolSummary(skipped);
  const buildPrompt = (evidence = '') => [
    basePrompt, '',
    'A bounded chat tool loop is in progress. The tools offered to you are executable. Infer capability from the offered tool surface and actual receipts only.',
    'Use the executed tool results below as local evidence. If more local action is required, call one of the available tools. Otherwise answer the user directly now.',
    runtimeNotice ? `\n${runtimeNotice}` : null,
    'Do not invent filesystem facts. Do not describe JSON command blobs as if they were executed.',
    'User request:', message, '', `Executed chat tool iteration ${iteration}:`, callSummary || '(no call summary)', '',
    'Executed tool results:', evidence || '(no executed continuation evidence)', '',
    'Skipped / not executed tool calls:', skippedSummary || '(none)', '',
    'Truth constraint: never describe a skipped tool call as completed. If a requested edit/write/append/change was skipped or lacks executed mutation evidence, say the file was NOT edited.',
  ].filter(Boolean).join('\n');
  const evidence = serializeContinuationEvidence({ toolResults, modelConfig, contextThreshold, tools: nativeToolSchemas(), buildPrompt });
  return buildPrompt(evidence);
}


export { compactSkippedToolActions, skippedToolSummary, executedToolResultPrompt };
