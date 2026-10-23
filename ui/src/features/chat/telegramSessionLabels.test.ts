import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadTelegramSessionLabels, telegramSessionLabels } from './telegramSessionLabels';

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

describe('Telegram session labels', () => {
  const state = {
    connections: [
      { id: 'default', name: 'Main bot', mappings: [{ chatId: -1001, topicId: null, chatTitle: 'Kingdom Trouble' }, { chatId: 42, topicId: null, chatTitle: 'Robert' }] },
      { id: 'connection-id', name: 'Alerts bot', mappings: [{ chatId: -1001, topicId: 7, topicName: 'Incidents', chatTitle: 'Kingdom Trouble' }] },
    ],
  };

  it('labels existing default, named-connection, direct, and topic sessions without changing their IDs', () => {
    const ids = ['telegram:-1001:root', 'telegram:42:root', 'telegram:connection-id:-1001:7'];
    const labels = telegramSessionLabels(ids, state);
    expect([...labels]).toEqual([
      ['telegram:-1001:root', { label: 'Telegram · Kingdom Trouble', title: 'telegram:-1001:root' }],
      ['telegram:42:root', { label: 'Telegram · Robert', title: 'telegram:42:root' }],
      ['telegram:connection-id:-1001:7', { label: 'Telegram · Kingdom Trouble · Incidents', title: 'telegram:connection-id:-1001:7' }],
    ]);
  });

  it('uses the topic ID when no topic name is exposed and connection names only to disambiguate duplicate labels', () => {
    const labels = telegramSessionLabels(
      ['telegram:one:-1001:7', 'telegram:two:-1001:7'],
      { connections: [
        { id: 'one', name: 'First bot', mappings: [{ chatId: -1001, topicId: 7, chatTitle: 'Kingdom Trouble' }] },
        { id: 'two', name: 'Second bot', mappings: [{ chatId: -1001, topicId: 7, chatTitle: 'Kingdom Trouble' }] },
      ] },
    );
    expect(labels.get('telegram:one:-1001:7')?.label).toBe('Telegram · Kingdom Trouble · 7 · First bot');
    expect(labels.get('telegram:two:-1001:7')?.label).toBe('Telegram · Kingdom Trouble · 7 · Second bot');
  });

  it('leaves unknown or malformed Telegram sessions unlabeled', () => {
    expect(telegramSessionLabels(['telegram:missing:root', 'telegram:too:many:parts:here', 'default'], state).size).toBe(0);
  });

  it('discovers the enabled Switchboard mod before reading its public bootstrap state', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ mods: [{ id: 'burrow-switchboard', status: 'loaded' }] }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(state), { status: 200, headers: { 'content-type': 'application/json' } }));
    const labels = await loadTelegramSessionLabels(['telegram:42:root']);
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual(['/api/mods', '/api/mods/burrow-switchboard/bootstrap']);
    expect(labels.get('telegram:42:root')?.label).toBe('Telegram · Robert');
  });

  it('does not request mod state when no Telegram session is present', async () => {
    await expect(loadTelegramSessionLabels(['default', 'a2a'])).resolves.toEqual(new Map());
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
