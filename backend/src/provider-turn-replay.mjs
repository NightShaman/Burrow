// Current automatic support is captured for evidence but excluded from later
// dialogue replay. Classification uses trusted provenance, never content text.
export function isCurrentTurnSupport(message) {
  const source = message?.metadata?.providerMessageSource;
  return ['support-context-provider', 'mod-shared-context-provider', 'mod-agent-context-provider'].includes(source)
    && ['user', 'developer'].includes(message?.role);
}

// Dispatch snapshots are immutable evidence of what an earlier request saw.
// Replaying a conversation is different: request-local support is supplied fresh
// by the current assembly, not accumulated once per historical operator turn.
// Select by runtime provenance, never by user-authored headings/content. Keep
// original user content and multimodal parts losslessly; never mutate evidence.
export function historicalProviderTurnMessages(snapshot) {
  if (snapshot?.version !== 1 || !Array.isArray(snapshot.messages)) return [];
  return snapshot.messages.filter(message => !['system', 'developer'].includes(message?.role)
    && !['support-context-provider', 'historical-support-snapshot', 'prior-execution-continuity', 'mod-shared-context-provider', 'mod-agent-context-provider']
      .includes(message?.metadata?.providerMessageSource));
}
