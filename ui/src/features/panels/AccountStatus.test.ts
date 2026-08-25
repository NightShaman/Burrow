import { describe, expect, it } from 'vitest';
import { accountVendor, anthropicBars, formatResetIn, oauthAccounts, openAiBars, orderAccountStatusCards, type AccountUsageCard } from './AccountStatus';
import type { SavedProvider } from '../../app/types';

const provider = (overrides: Partial<SavedProvider>): SavedProvider => ({
  id: 'c1', provider: 'Anthropic', apiType: 'anthropic-messages', url: 'https://api.anthropic.com', apiKey: '', models: [], ...overrides,
});

describe('accountVendor', () => {
  it('detects Anthropic and OpenAI connections', () => {
    expect(accountVendor(provider({}))).toBe('Anthropic');
    expect(accountVendor(provider({ provider: 'OpenAI', apiType: 'openai-responses', url: 'https://chatgpt.com/backend-api' }))).toBe('OpenAI');
    expect(accountVendor(provider({ provider: 'Ollama', apiType: 'openai-chat-completions', url: 'http://localhost:11434' }))).toBeNull();
  });
});

describe('oauthAccounts', () => {
  it('keeps only OAuth-configured Anthropic/OpenAI connections', () => {
    const list = oauthAccounts([
      provider({ id: 'a', auth: { type: 'oauth' } }),
      provider({ id: 'b', apiKeyConfigured: true }),
      provider({ id: 'c', provider: 'OpenAI', apiType: 'openai-responses', url: 'https://chatgpt.com/backend-api', oauthConfigured: true }),
      provider({ id: 'd', provider: 'Ollama', apiType: 'openai-chat-completions', url: 'http://localhost:11434', oauthConfigured: true }),
    ]);
    expect(list.map((entry) => [entry.provider.id, entry.vendor])).toEqual([['a', 'Anthropic'], ['c', 'OpenAI']]);
  });
});

describe('usage bars', () => {
  it('maps Anthropic windows to remaining percentages, primary first', () => {
    expect(anthropicBars({ windows: [
      { key: 'seven_day', usedPercent: 40, resetAt: '2030-01-01T00:00:00.000Z' },
      { key: 'five_hour', usedPercent: 25, resetAt: '2030-01-01T00:00:00.000Z' },
    ] })).toEqual([
      { key: 'five_hour', label: 'Five Hour', remainingPercent: 75, resetAt: '2030-01-01T00:00:00.000Z' },
      { key: 'seven_day', label: 'Seven Day', remainingPercent: 60, resetAt: '2030-01-01T00:00:00.000Z' },
    ]);
  });

  it('maps OpenAI windows and tolerates missing percentages', () => {
    expect(openAiBars({ windows: [
      { key: 'primary', label: '5h', usedPercent: 10, resetAt: null },
      { key: 'secondary', label: '7d', usedPercent: null, resetAt: null },
    ] })).toEqual([
      { key: 'primary', label: '5h', remainingPercent: 90, resetAt: null },
      { key: 'secondary', label: '7d', remainingPercent: null, resetAt: null },
    ]);
  });

  it('returns no bars without usage', () => {
    expect(anthropicBars(null)).toEqual([]);
    expect(openAiBars({ windows: [] })).toEqual([]);
  });
});

describe('formatResetIn', () => {
  const now = Date.parse('2030-01-01T00:00:00.000Z');
  it('formats minutes, hours, and days', () => {
    expect(formatResetIn('2030-01-01T00:45:00.000Z', now)).toBe('45m');
    expect(formatResetIn('2030-01-01T03:30:00.000Z', now)).toBe('3h 30m');
    expect(formatResetIn('2030-01-03T00:00:00.000Z', now)).toBe('2d');
  });
  it('handles missing and past timestamps', () => {
    expect(formatResetIn(null, now)).toBeNull();
    expect(formatResetIn('2029-12-31T00:00:00.000Z', now)).toBe('now');
  });
});


describe('account status ordering', () => {
  const card = (id: string): AccountUsageCard => ({ id, name: id, vendor: 'OpenAI', plan: null, state: 'ready', bars: [] });

  it('uses the persisted order and appends new OAuth accounts', () => {
    expect(orderAccountStatusCards([card('a'), card('b'), card('c')], ['b', 'a']).map((entry) => entry.id)).toEqual(['b', 'a', 'c']);
  });
});
