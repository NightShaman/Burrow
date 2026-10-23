import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadSwitchboardSessionLabels, switchboardSessionLabels } from './telegramSessionLabels';

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

describe('Switchboard session labels', () => {
  const state = {
    connections: [
      { id: 'default', name: 'Main bot', mappings: [{ chatId: -1001, topicId: null, chatTitle: 'Kingdom Trouble' }, { chatId: 42, topicId: null, chatTitle: 'Robert' }] },
      { id: 'connection-id', name: 'Alerts bot', mappings: [{ chatId: -1001, topicId: 7, topicName: 'Incidents', chatTitle: 'Kingdom Trouble' }] },
    ],
  };

  it('labels existing default, named-connection, direct, and topic sessions without changing their IDs', () => {
    const ids = ['telegram:-1001:root', 'telegram:42:root', 'telegram:connection-id:-1001:7'];
    const labels = switchboardSessionLabels(ids, state);
    expect([...labels]).toEqual([
      ['telegram:-1001:root', { label: 'Telegram · Kingdom Trouble', title: 'telegram:-1001:root' }],
      ['telegram:42:root', { label: 'Telegram · Robert', title: 'telegram:42:root' }],
      ['telegram:connection-id:-1001:7', { label: 'Telegram · Kingdom Trouble · Incidents', title: 'telegram:connection-id:-1001:7' }],
    ]);
  });

  it('uses the topic ID when no topic name is exposed and connection names only to disambiguate duplicate labels', () => {
    const labels = switchboardSessionLabels(
      ['telegram:one:-1001:7', 'telegram:two:-1001:7'],
      { connections: [
        { id: 'one', name: 'First bot', mappings: [{ chatId: -1001, topicId: 7, chatTitle: 'Kingdom Trouble' }] },
        { id: 'two', name: 'Second bot', mappings: [{ chatId: -1001, topicId: 7, chatTitle: 'Kingdom Trouble' }] },
      ] },
    );
    expect(labels.get('telegram:one:-1001:7')?.label).toBe('Telegram · Kingdom Trouble · 7 · First bot');
    expect(labels.get('telegram:two:-1001:7')?.label).toBe('Telegram · Kingdom Trouble · 7 · Second bot');
  });

  it('labels Discord channels from channelId or chatId and keeps transport namespaces separate', () => {
    const labels = switchboardSessionLabels(
      ['discord:one:123', 'discord:two:456', 'telegram:one:123:root', 'telegram:two:456:root'],
      { connections: [
        { id: 'one', name: 'Community', transportType: 'discord', mappings: [{ channelId: '123', chatId: 'unrelated', chatTitle: 'General', topicName: 'Ignored topic' }] },
        { id: 'two', name: 'Operations', transportType: 'discord', mappings: [{ chatId: 456, chatTitle: 'General' }] },
      ] },
    );
    expect([...labels]).toEqual([
      ['discord:one:123', { label: 'Discord · General · Community', title: 'discord:one:123' }],
      ['discord:two:456', { label: 'Discord · General · Operations', title: 'discord:two:456' }],
    ]);
  });

  it('does not mislabel a Telegram session from Discord metadata or Discord from Telegram metadata', () => {
    const labels = switchboardSessionLabels(['telegram:default:42:root', 'discord:legacy:42', 'discord:bad:42'], { connections: [
      { id: 'default', transportType: 'discord', mappings: [{ chatId: 42, chatTitle: 'Wrong Telegram' }] },
      { id: 'legacy', mappings: [{ chatId: 42, chatTitle: 'Wrong Discord' }] },
      { id: 'bad', transportType: 'telegram', mappings: [{ channelId: 42, chatTitle: 'Wrong Discord' }] },
    ] });
    expect(labels.size).toBe(0);
  });

  it('supports explicitly typed Telegram connections and leaves malformed or unmapped IDs unchanged', () => {
    const labels = switchboardSessionLabels(
      ['telegram:typed:42:root', 'discord:bad:42:extra', 'discord::42', 'discord:typed:42', 'telegram:missing:root', 'telegram:too:many:parts:here', 'default'],
      { connections: [{ id: 'typed', transportType: 'telegram', mappings: [{ chatId: 42, chatTitle: 'Robert' }] }] },
    );
    expect([...labels]).toEqual([['telegram:typed:42:root', { label: 'Telegram · Robert', title: 'telegram:typed:42:root' }]]);
  });

  it('discovers the enabled Switchboard mod before reading its public bootstrap state', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ mods: [{ id: 'burrow-switchboard', status: 'loaded' }] }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(state), { status: 200, headers: { 'content-type': 'application/json' } }));
    const labels = await loadSwitchboardSessionLabels(['telegram:42:root']);
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual(['/api/mods', '/api/mods/burrow-switchboard/bootstrap']);
    expect(labels.get('telegram:42:root')?.label).toBe('Telegram · Robert');
  });

  it('fetches the same bootstrap once for mixed Telegram and Discord sessions', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ mods: [{ id: 'burrow-switchboard', status: 'loaded' }] }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ connections: [
        ...state.connections,
        { id: 'guild', name: 'Discord server', transportType: 'discord', mappings: [{ channelId: '123', chatTitle: 'Town Hall' }] },
      ] }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const labels = await loadSwitchboardSessionLabels(['telegram:42:root', 'discord:guild:123']);
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual(['/api/mods', '/api/mods/burrow-switchboard/bootstrap']);
    expect(labels.get('telegram:42:root')?.label).toBe('Telegram · Robert');
    expect(labels.get('discord:guild:123')?.label).toBe('Discord · Town Hall');
  });

  it('does not request mod state when no supported session is present', async () => {
    await expect(loadSwitchboardSessionLabels(['default', 'a2a'])).resolves.toEqual(new Map());
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
