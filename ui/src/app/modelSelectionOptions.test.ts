import { describe, expect, it } from 'vitest';
import type { SavedProvider } from './types';
import { nativeThinkingOptions, thinkingModeLabel } from './modelSelectionOptions';
const provider: SavedProvider = {
  id: 'native',
  provider: 'Native',
  apiType: 'anthropic-messages',
  url: '',
  apiKey: '',
  models: ['future-native'],
  modelEfforts: { 'future-native': ['low', 'high', 'xhigh'] },
  connectionModels: [
    {
      id: 'future-native',
      thinkingModes: ['default', 'adaptive', 'between_tools'],
      thinkingEfforts: {
        default: ['low', 'high', 'max'],
        adaptive: ['low', 'high', 'max'],
        between_tools: ['low', 'high'],
      },
    },
  ],
};
describe('native thinking projection', () => {
  it('uses projected modes and efforts without model-name inference or aliases', () => {
    const result = nativeThinkingOptions(provider, 'future-native', 'adaptive', 'max');
    expect(result.modes).toEqual(['default', 'adaptive', 'between_tools']);
    expect(result.efforts).toEqual(['off', 'low', 'high', 'max']);
    expect(result.issue).toBe('');
  });
  it('retains unsupported raw Off rather than selecting Default or Adaptive', () => {
    const result = nativeThinkingOptions(provider, 'future-native', null, 'off');
    expect(result.modeInvalid).toBe(true);
    expect(result.legacyLabel).toBe('Legacy · Off (unsupported)');
    expect(result.issue).toContain('Choose a thinking mode');
    expect(result.efforts).toEqual(['off']);
  });
  it('keeps legacy positive effort visible without offering new generic choices', () => {
    const result = nativeThinkingOptions(provider, 'future-native', null, 'xhigh');
    expect(result.legacyLabel).toBe('Legacy · Adaptive');
    expect(result.efforts).toEqual(['xhigh']);
  });
  it('does not convert incompatible saved effort on a mode change', () => {
    const result = nativeThinkingOptions(provider, 'future-native', 'between_tools', 'max');
    expect(result.effortInvalid).toBe(true);
    expect(result.efforts).toEqual(['off', 'low', 'high']);
    expect(result.issue).toContain('max');
  });
  it('explicit Default/Default is not legacy Off', () => {
    expect(nativeThinkingOptions(provider, 'future-native', 'default', 'off').issue).toBe('');
  });
  it('unknown model offers only explicit provider default, not guessed native modes', () => {
    expect(nativeThinkingOptions(provider, 'unrecognized', 'default', 'off').modes).toEqual([
      'default',
    ]);
  });
  it('retains unknown explicit values as invalid', () => {
    expect(nativeThinkingOptions(provider, 'future-native', 'other', 'ultra').issue).toContain(
      'thinking mode',
    );
  });
  it('labels native API values without changing them', () => {
    expect(thinkingModeLabel('enabled')).toBe('Manual');
    expect(thinkingModeLabel('between_tools')).toBe('No up-front thinking');
  });
});

it('validates retained manual budgets independently from unavailable native efforts', () => {
  const manual = {
    ...provider,
    connectionModels: [
      {
        id: 'future-native',
        thinkingModes: ['default', 'disabled', 'enabled'],
        thinkingEfforts: { default: [], disabled: [], enabled: [] },
      },
    ],
  };
  for (const effort of ['high', 'ultra'])
    expect(nativeThinkingOptions(manual, 'future-native', null, effort).issue).toBe('');
});
it('validates legacy adaptive aliases without silently converting their stored values', () => {
  expect(nativeThinkingOptions(provider, 'future-native', null, 'xhigh').effortInvalid).toBe(true);
  const result = nativeThinkingOptions(provider, 'future-native', null, 'ultra');
  expect(result.effortInvalid).toBe(false);
  expect(result.efforts).toEqual(['ultra']);
});
