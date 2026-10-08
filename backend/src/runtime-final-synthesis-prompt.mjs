import { skippedToolSummary } from './tool-continuation-prompt.mjs';
import { serializeContinuationEvidence } from './continuation-evidence.mjs';

export function finalAnswerAfterToolLoopPrompt({ basePrompt = '', message = '', toolResults = [], skipped = [], runtimeNotice = null, modelConfig = null, contextThreshold = null, preparePrompt } = {}) {
  const skippedSummary = skippedToolSummary(skipped);
  const buildPrompt = (evidence = '') => [
    basePrompt, '',
    'The bounded chat tool loop has ended. Answer the user directly using only the executed tool evidence below and the conversation context.',
    runtimeNotice || null,
    'If the evidence is insufficient, say exactly what is missing. Do not ask the user to paste files that you already tried to inspect.',
    'Never describe skipped tool calls as completed. If a requested edit/write/append/change was skipped or lacks executed mutation evidence, say the file was NOT edited.',
    '', 'User request:', message, '', 'Executed tool evidence:', evidence || '(no executed continuation evidence)', '',
    'Skipped / not executed tool calls:', skippedSummary || '(none)',
  ].filter(Boolean).join('\n');
  const evidence = serializeContinuationEvidence({ toolResults, modelConfig, contextThreshold, buildPrompt, preparePrompt });
  return buildPrompt(evidence);
}
