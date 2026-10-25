import { describe, expect, it } from 'vitest';
import type { SavedProvider } from './types';
import { isOpenAiOAuthConnection } from './useRuntimeDashboard';

const provider = (changes: Partial<SavedProvider> = {}): SavedProvider => ({
  id: 'connection-1',
  provider: 'Business 2',
  apiType: 'openai-responses',
  url: 'https://chatgpt.com/backend-api',
  apiKey: '',
  models: ['gpt-5.5'],
  ...changes,
});

describe('OpenAI OAuth usage connections', () => {
  it('recognizes OAuth metadata when the connection has a custom display name', () => {
    expect(isOpenAiOAuthConnection(provider({ auth: { type: 'oauth', source: 'openai-oauth' } }))).toBe(true);
  });

  it('does not treat an API-key OpenAI-compatible connection as OAuth', () => {
    expect(isOpenAiOAuthConnection(provider({ auth: { type: 'api_key', source: 'legacy-api-key' } }))).toBe(false);
  });
});
