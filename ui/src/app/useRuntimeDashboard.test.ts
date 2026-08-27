import { describe, expect, it } from 'vitest';
import type { SavedProvider } from './types';
import { asCodexAccount, isOpenAiOAuthConnection } from './useRuntimeDashboard';

const provider = (changes: Partial<SavedProvider> = {}): SavedProvider => ({
  id: 'connection-1',
  provider: 'Business 2',
  apiType: 'openai-responses',
  url: 'https://chatgpt.com/backend-api',
  apiKey: '',
  models: ['gpt-5.5'],
  ...changes,
});

describe('Codex-LB account mapping', () => {
  it('maps primary and secondary quota windows to remaining meters', () => {
    expect(asCodexAccount({ id: 'a', name: 'Main', type: 'Team', status: 'Active', usagePercent: 62, resetAt: '2030-01-01T00:00:00Z', quotaWindows: {
      primary: { label: '5-hour', percent: 62, resetAt: '2030-01-01T00:00:00Z' },
      secondary: { label: 'Weekly', percent: 94, resetAt: '2030-01-07T00:00:00Z' },
    } }, 0).meters).toEqual([
      { key: 'primary', label: '5-hour', remainingPercent: 38, resetAt: '2030-01-01T00:00:00Z' },
      { key: 'secondary', label: 'Weekly', remainingPercent: 6, resetAt: '2030-01-07T00:00:00Z' },
    ]);
  });

  it('preserves the legacy account shape when quota windows are absent', () => {
    expect(asCodexAccount({ usagePercent: 10, resetAt: null }, 0).meters).toEqual([]);
  });
});

describe('OpenAI OAuth usage connections', () => {
  it('recognizes OAuth metadata when the connection has a custom display name', () => {
    expect(isOpenAiOAuthConnection(provider({ auth: { type: 'oauth', source: 'openai-oauth' } }))).toBe(true);
  });

  it('does not treat an API-key OpenAI-compatible connection as OAuth', () => {
    expect(isOpenAiOAuthConnection(provider({ auth: { type: 'api_key', source: 'legacy-api-key' } }))).toBe(false);
  });
});
