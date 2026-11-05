// Dispatch snapshots are immutable evidence of what an earlier request saw.
// Replaying a conversation is different: request-local support is supplied fresh
// by the current assembly, not accumulated once per historical operator turn.
// Select by runtime provenance, never by user-authored headings/content. Keep
// original user content and multimodal parts losslessly; never mutate evidence.
export function historicalProviderTurnMessages(snapshot) {
  if (snapshot?.version !== 1 || !Array.isArray(snapshot.messages)) return [];
  return snapshot.messages.filter(message => !['support-context-provider', 'historical-support-snapshot']
    .includes(message?.metadata?.providerMessageSource));
}
