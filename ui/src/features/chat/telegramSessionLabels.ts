import { api } from '../../app/api';

export type SwitchboardSessionLabel = { label: string; title: string };

type SwitchboardMapping = {
  chatId?: string | number;
  channelId?: string | number;
  topicId?: string | number | null;
  topicName?: string | null;
  chatTitle?: string | null;
};

type SwitchboardConnection = {
  id?: string;
  name?: string;
  transportType?: string;
  mappings?: SwitchboardMapping[];
};

type SwitchboardState = { connections?: SwitchboardConnection[] };

type TelegramRoute = { transport: 'telegram'; connectionId: string; chatId: string; topicId: string | null };
type DiscordRoute = { transport: 'discord'; connectionId: string; channelId: string };
type SwitchboardRoute = TelegramRoute | DiscordRoute;

function sessionRoute(sessionId: string): SwitchboardRoute | null {
  const parts = sessionId.split(':');
  if (parts[0] === 'discord' && parts.length === 3 && parts[1] && parts[2]) {
    return { transport: 'discord', connectionId: parts[1], channelId: parts[2] };
  }
  if (parts[0] !== 'telegram') return null;
  if (parts.length === 3) return { transport: 'telegram', connectionId: 'default', chatId: parts[1], topicId: parts[2] === 'root' ? null : parts[2] };
  if (parts.length === 4) return { transport: 'telegram', connectionId: parts[1], chatId: parts[2], topicId: parts[3] === 'root' ? null : parts[3] };
  return null;
}

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function sameNullableId(left: string | number | null | undefined, right: string | null) {
  return (left == null ? null : String(left)) === right;
}

export function switchboardSessionLabels(sessionIds: string[], state: SwitchboardState): Map<string, SwitchboardSessionLabel> {
  const matches = sessionIds.flatMap((sessionId) => {
    const route = sessionRoute(sessionId);
    if (!route) return [];
    const connection = (state.connections ?? []).find((item) => item.id === route.connectionId && (
      route.transport === 'discord' ? item.transportType === 'discord' : (item.transportType == null || item.transportType === 'telegram')
    ));
    const mapping = route.transport === 'discord'
      ? connection?.mappings?.find((item) => String(item.channelId ?? '') === route.channelId || String(item.chatId ?? '') === route.channelId)
      : connection?.mappings?.find((item) => String(item.chatId ?? '') === route.chatId && sameNullableId(item.topicId, route.topicId));
    const chatTitle = cleanText(mapping?.chatTitle);
    if (!connection || !mapping || !chatTitle) return [];
    const topicName = route.transport === 'telegram' ? cleanText(mapping.topicName) : '';
    const topicLabel = route.transport === 'telegram' && route.topicId != null ? topicName || route.topicId : '';
    const baseLabel = `${route.transport === 'discord' ? 'Discord' : 'Telegram'} · ${chatTitle}${topicLabel ? ` · ${topicLabel}` : ''}`;
    return [{ sessionId, baseLabel, connectionName: cleanText(connection.name) }];
  });
  const counts = new Map<string, number>();
  for (const match of matches) counts.set(match.baseLabel, (counts.get(match.baseLabel) ?? 0) + 1);
  return new Map(matches.map((match) => {
    const disambiguate = (counts.get(match.baseLabel) ?? 0) > 1 && match.connectionName;
    return [match.sessionId, { label: disambiguate ? `${match.baseLabel} · ${match.connectionName}` : match.baseLabel, title: match.sessionId }];
  }));
}

export async function loadSwitchboardSessionLabels(sessionIds: string[], signal?: AbortSignal): Promise<Map<string, SwitchboardSessionLabel>> {
  const switchboardIds = sessionIds.filter((id) => sessionRoute(id));
  if (!switchboardIds.length) return new Map();
  const catalog = await api<{ mods?: Array<{ id?: unknown; status?: unknown }> }>('/api/mods', { signal });
  const switchboard = (catalog.mods ?? []).find((mod) => mod.id === 'burrow-switchboard' && mod.status !== 'disabled' && mod.status !== 'failed');
  if (!switchboard) return new Map();
  const state = await api<SwitchboardState>('/api/mods/burrow-switchboard/bootstrap', { signal });
  return switchboardSessionLabels(switchboardIds, state);
}
