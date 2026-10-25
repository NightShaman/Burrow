import type { SavedProvider } from '../../app/types';

export const isProviderPool = (apiType: string) => apiType === 'openai-lb' || apiType === 'anthropic-lb';

export function compatiblePoolMembers(apiType: string, connections: SavedProvider[]) {
  return connections.filter((connection) => {
    if (connection.pool || isProviderPool(connection.apiType) || connection.auth?.type !== 'oauth') return false;
    const provider = connection.auth.provider?.toLowerCase();
    return apiType === 'openai-lb'
      ? provider === 'openai' && ['openai-responses', 'openai-chat-completions'].includes(connection.apiType)
      : apiType === 'anthropic-lb' && ['anthropic', 'claude'].includes(provider ?? '') && connection.apiType === 'anthropic-messages';
  });
}
