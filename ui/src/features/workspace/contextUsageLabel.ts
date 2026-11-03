import type { ContextDetails } from '../../app/types';

/** Only correlated response evidence can describe measured input or a returned model. */
export function contextUsageLabel(value: number | null, details?: ContextDetails): string {
  const latest = details?.scope === 'latest-request' && Boolean(details.requestId);
  const response = latest && details?.stage === 'response';
  const measured = response && details?.providerInputTokens != null;
  const heading = latest
    ? measured
      ? 'Latest request input (provider reported)'
      : 'Latest request estimate'
    : details?.scope === 'reconstructed'
      ? 'Reconstructed dialogue estimate'
      : 'Historical estimate';
  const tokens = measured ? details.providerInputTokens : details?.estimatedTokens;
  const capacity =
    details?.capacityTokens != null
      ? ` / ${details.capacityTokens.toLocaleString()} tokens`
      : ' tokens';
  const parts = [
    tokens != null
      ? `${heading}: ${tokens.toLocaleString()}${capacity}${value !== null ? ` (${value}%)` : ''}.`
      : `${heading}: unavailable.`,
  ];
  if (measured && details.requestEstimatedTokens != null) {
    parts.push(
      `Matching request estimate: ${details.requestEstimatedTokens.toLocaleString()} tokens.`,
    );
  }
  if (details?.pressure) {
    parts.push(`Budget pressure: ${details.pressure} (classification, not execution status).`);
  }
  if (latest) {
    const provider = details?.providerName || details?.provider;
    if (provider) parts.push(`Serving provider: ${provider}.`);
    if (details?.model) parts.push(`Requested model: ${details.model}.`);
    if (response && details?.responseModel) parts.push(`Returned model: ${details.responseModel}.`);
  }
  if (details?.compactionActive) {
    parts.push(
      `Compaction enabled${details.rawRecentTurnCount != null ? `; ${details.rawRecentTurnCount} recent turns kept raw` : ''}.`,
    );
  }
  return parts.join(' ');
}
