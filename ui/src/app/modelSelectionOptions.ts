import type { SavedProvider } from './types';

export const reasoningEffortsForModel = (provider: SavedProvider | undefined, model: string) => [
  'off',
  ...(provider?.modelEfforts?.[model] ?? []).filter((effort) => effort !== 'off'),
];
export const defaultReasoningEffort = (provider: SavedProvider | undefined, model: string) =>
  provider?.defaultEfforts?.[model] ?? provider?.modelEfforts?.[model]?.[0] ?? 'off';

export const isNativeThinkingProvider = (provider: SavedProvider | undefined) =>
  provider?.apiType === 'anthropic-messages' || provider?.apiType === 'anthropic-lb';

export const thinkingModeLabel = (mode: string) =>
  ({
    default: 'Default',
    disabled: 'Disabled',
    adaptive: 'Adaptive',
    enabled: 'Manual',
    between_tools: 'No up-front thinking',
  })[mode] ?? mode;

/** Use the server's native capability projection, never model-name guesses.
 * A null mode is retained legacy intent, not an explicit provider default. */
export function nativeThinkingOptions(
  provider: SavedProvider | undefined,
  model: string,
  mode: string | null | undefined,
  effort: string,
) {
  const capabilities = provider?.connectionModels?.find((item) => item.id === model);
  const known = Array.isArray(capabilities?.thinkingModes);
  const modes = capabilities?.thinkingModes ?? ['default'];
  const legacyMode = !effort
    ? 'default'
    : effort === 'off'
      ? 'disabled'
      : modes.includes('adaptive')
        ? 'adaptive'
        : 'enabled';
  const resolvedMode = mode ?? legacyMode;
  const modeInvalid = (known || mode != null) && !modes.includes(resolvedMode);
  const efforts =
    mode == null
      ? [effort]
      : [
          'off',
          ...(capabilities?.thinkingEfforts?.[mode] ?? []).filter((value) => value !== 'off'),
        ];
  // Validate retained legacy intent using its established backend interpretation
  // only. These aliases never become editable choices or rewrite the raw value.
  const legacyEffort =
    ({ minimal: 'low', ultra: 'max' } as Record<string, string>)[effort] ?? effort;
  const legacyValid =
    effort === 'off' ||
    !effort ||
    (legacyMode === 'enabled'
      ? ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(effort)
      : (capabilities?.thinkingEfforts?.[legacyMode]?.includes(legacyEffort) ?? !known));
  const effortInvalid = mode == null ? !legacyValid : !efforts.includes(effort);
  const legacyLabel = `Legacy · ${effort === 'off' ? 'Off' : thinkingModeLabel(legacyMode)}${modeInvalid ? ' (unsupported)' : ''}`;
  const issue = modeInvalid
    ? mode == null && effort === 'off'
      ? 'Saved Off cannot disable thinking on this model. Choose a thinking mode.'
      : 'The saved thinking mode is unavailable for this model. Choose a thinking mode.'
    : effortInvalid
      ? `Saved effort “${effort}” is unavailable for this mode. Choose an effort.`
      : '';
  return { modes, efforts, modeInvalid, effortInvalid, legacyLabel, issue };
}
