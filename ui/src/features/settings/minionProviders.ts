import type { ModelConnection } from '../../app/api';
import type { SavedProvider } from '../../app/types';
export function minionProviders(
  connections: ModelConnection[],
  harness: 'burrow' | 'codex' | 'claude',
): SavedProvider[] {
  return connections
    .filter(
      (c) =>
        c.enabled !== false &&
        (harness === 'burrow' ||
          (harness === 'codex'
            ? (c.apiType === 'openai-lb' && c.codexEligible === true) ||
              (['openai-responses', 'openai-chat-completions'].includes(c.apiType) &&
                c.auth?.type?.toLowerCase() === 'oauth' &&
                c.auth?.provider?.toLowerCase() === 'openai')
            : (c.apiType === 'anthropic-lb' && c.claudeEligible === true) ||
              (c.apiType === 'anthropic-messages' &&
                c.auth?.type?.toLowerCase() === 'oauth' &&
                ['anthropic', 'claude'].includes(c.auth?.provider?.toLowerCase() ?? '')))),
    )
    .map((c) => ({
      id: c.id,
      provider: c.provider,
      apiType: c.apiType,
      url: c.baseUrl,
      apiKey: '',
      models: c.models.filter((m) => m.selected !== false).map((m) => m.id),
      modelLabels: Object.fromEntries(c.models.map((m) => [m.id, m.displayName ?? m.id])),
    }));
}
