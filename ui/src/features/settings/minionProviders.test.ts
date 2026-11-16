import { expect, it } from 'vitest';
import type { ModelConnection } from '../../app/api';
import { minionProviders } from './minionProviders';
it('admits only enabled eligible native Google connections and enabled catalog model IDs', () => {
  const native = {
    id: 'google',
    provider: 'Google',
    apiType: 'google-generative-language',
    geminiEligible: true,
    enabled: true,
    models: [
      { id: 'gemini-latest', displayName: 'Gemini Latest' },
      { id: 'hidden', selected: false },
    ],
  };
  const connections = [
    native,
    { ...native, id: 'lb', apiType: 'google-lb' },
    { ...native, id: 'disabled', enabled: false },
    { ...native, id: 'unknown', geminiEligible: undefined },
    { ...native, id: 'ineligible', geminiEligible: false },
  ] as ModelConnection[];
  expect(minionProviders(connections, 'gemini')).toEqual([
    expect.objectContaining({
      id: 'google',
      models: ['gemini-latest'],
      modelLabels: expect.objectContaining({ 'gemini-latest': 'Gemini Latest' }),
    }),
  ]);
});
