import { api } from '../../app/api';

export type TelegramSessionLabel = { label: string; title: string };

type SwitchboardMapping = {
  chatId?: string | number;
  topicId?: string | number | null;
  topicName?: string | null;
  chatTitle?: string | null;
};

type SwitchboardConnection = {
  id?: string;
  name?: string;
  mappings?: SwitchboardMapping[];
};

type SwitchboardState = { connections?: SwitchboardConnection[] };

type TelegramRoute = { connectionId: string; chatId: string; topicId: string | null };

function telegramRoute(sessionId: string): TelegramRoute | null {
  const parts = sessionId.split(':');
  if (parts[0] !== 'telegram') return null;
  if (parts.length === 3) return { connectionId: 'default', chatId: parts[1], topicId: parts[2] === 'root' ? null : parts[2] };
  if (parts.length === 4) return { connectionId: parts[1], chatId: parts[2], topicId: parts[3] === 'root' ? null : parts[3] };
  return null;
}

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function sameNullableId(left: string | number | null | undefined, right: string | null) {
  return (left == null ? null : String(left)) === right;
}

export function telegramSessionLabels(sessionIds: string[], state: SwitchboardState): Map<string, TelegramSessionLabel> {
  const matches = sessionIds.flatMap((sessionId) => {
    const route = telegramRoute(sessionId);
    if (!route) return [];
    const connection = (state.connections ?? []).find((item) => item.id === route.connectionId);
    const mapping = connection?.mappings?.find((item) => String(item.chatId ?? '') === route.chatId && sameNullableId(item.topicId, route.topicId));
    const chatTitle = cleanText(mapping?.chatTitle);
    if (!connection || !mapping || !chatTitle) return [];
    const topicName = cleanText(mapping.topicName);
    const topicLabel = route.topicId == null ? '' : topicName || route.topicId;
    const baseLabel = `Telegram · ${chatTitle}${topicLabel ? ` · ${topicLabel}` : ''}`;
    return [{ sessionId, baseLabel, connectionName: cleanText(connection.name) }];
  });
  const counts = new Map<string, number>();
  for (const match of matches) counts.set(match.baseLabel, (counts.get(match.baseLabel) ?? 0) + 1);
  return new Map(matches.map((match) => {
    const disambiguate = (counts.get(match.baseLabel) ?? 0) > 1 && match.connectionName;
    return [match.sessionId, { label: disambiguate ? `${match.baseLabel} · ${match.connectionName}` : match.baseLabel, title: match.sessionId }];
  }));
}

export async function loadTelegramSessionLabels(sessionIds: string[], signal?: AbortSignal): Promise<Map<string, TelegramSessionLabel>> {
  const telegramIds = sessionIds.filter((id) => telegramRoute(id));
  if (!telegramIds.length) return new Map();
  const catalog = await api<{ mods?: Array<{ id?: unknown; status?: unknown }> }>('/api/mods', { signal });
  const switchboard = (catalog.mods ?? []).find((mod) => mod.id === 'burrow-switchboard' && mod.status !== 'disabled' && mod.status !== 'failed');
  if (!switchboard) return new Map();
  const state = await api<SwitchboardState>('/api/mods/burrow-switchboard/bootstrap', { signal });
  return telegramSessionLabels(telegramIds, state);
}
