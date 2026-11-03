import { describe, expect, it } from 'vitest';
import type { ContextDetails } from '../../app/types';
import { contextUsageLabel } from './contextUsageLabel';
const details: ContextDetails = {
  estimatedTokens: 320000,
  capacityTokens: 500000,
  pressure: 'ok',
  source: 'provider-input-tokens',
  compactionActive: false,
  summarizedTurnCount: null,
  rawRecentTurnCount: null,
  scope: 'latest-request',
  requestId: 'physical',
  stage: 'response',
  providerInputTokens: 320000,
  requestEstimatedTokens: 600000,
  providerName: 'Serving provider',
  model: 'requested',
  responseModel: 'returned',
};
describe('context usage evidence', () => {
  it('shows matching measured usage and original estimate distinctly', () => {
    const label = contextUsageLabel(64, details);
    expect(label).toContain(
      'Latest request input (provider reported): 320,000 / 500,000 tokens (64%)',
    );
    expect(label).toContain('Matching request estimate: 600,000 tokens');
    expect(label).toContain(
      'Serving provider: Serving provider. Requested model: requested. Returned model: returned.',
    );
  });
  it('does not present pressure as execution status', () => {
    expect(contextUsageLabel(100, { ...details, pressure: 'blocked' })).toContain(
      'Budget pressure: blocked (classification, not execution status)',
    );
  });
  it('does not leak response usage or returned model into a new request estimate', () => {
    const label = contextUsageLabel(18, {
      ...details,
      stage: 'request-estimate',
      estimatedTokens: 90000,
    });
    expect(label).toContain('Latest request estimate: 90,000');
    expect(label).not.toContain('320,000');
    expect(label).not.toContain('Returned model');
  });
  it.each(['historical', 'reconstructed'] as const)(
    'labels %s and excludes uncorrelated response fields',
    (scope) => {
      const label = contextUsageLabel(64, { ...details, scope });
      expect(label).toContain(
        scope === 'historical' ? 'Historical estimate' : 'Reconstructed dialogue estimate',
      );
      expect(label).not.toContain('provider reported');
      expect(label).not.toContain('Returned model');
      expect(label).not.toContain('Serving provider');
    },
  );
  it('does not infer a returned model from the requested model', () => {
    expect(contextUsageLabel(64, { ...details, responseModel: null })).not.toContain(
      'Returned model',
    );
  });
  it('keeps unknown values unknown including legacy payloads', () => {
    expect(contextUsageLabel(null)).toBe('Historical estimate: unavailable.');
    expect(
      contextUsageLabel(null, { ...details, providerInputTokens: null, estimatedTokens: null }),
    ).toContain('Latest request estimate: unavailable.');
  });
  it('preserves reported zero tokens', () => {
    expect(contextUsageLabel(0, { ...details, providerInputTokens: 0 })).toContain(
      'provider reported): 0 /',
    );
  });
});
