import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { conversationAuthority } from './conversation-authority.mjs';

const ID = /^[a-zA-Z0-9._-]{1,96}$/;
const safe = (value, field) => {
  const id = String(value || '').trim();
  if (!ID.test(id)) throw new Error(`${field}_invalid`);
  return id;
};
const channelsRoot = (rootDir) => path.join(rootDir, 'group-channels');
const channelDir = (rootDir, id) => path.join(channelsRoot(rootDir), safe(id, 'group_channel_id'));
const metaFile = (rootDir, id) => path.join(channelDir(rootDir, id), 'channel.json');
const now = () => new Date().toISOString();

export async function createGroupChannel({ rootDir, id = null, name = '', participantAgentIds = [] } = {}) {
  if (!rootDir) throw new Error('rootDir_required');
  const channelId = safe(id || `group-${randomUUID()}`, 'group_channel_id');
  const participants = [...new Set((participantAgentIds || []).map((agentId) => safe(agentId, 'group_participant_agent_id')))];
  if (!participants.length) throw new Error('group_participants_required');
  const dir = channelDir(rootDir, channelId);
  await fs.mkdir(channelsRoot(rootDir), { recursive: true });
  await fs.mkdir(dir, { recursive: false }).catch((error) => { if (error?.code === 'EEXIST') throw new Error('group_channel_exists'); throw error; });
  const createdAt = now();
  const channel = { id: channelId, name: String(name || '').trim().slice(0, 240) || channelId, participantAgentIds: participants, createdAt, updatedAt: createdAt };
  await fs.writeFile(metaFile(rootDir, channelId), `${JSON.stringify(channel, null, 2)}\n`, 'utf8');
  return channel;
}

export async function readGroupChannel({ rootDir, id } = {}) {
  try { return JSON.parse(await fs.readFile(metaFile(rootDir, id), 'utf8')); } catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

export async function listGroupChannels({ rootDir } = {}) {
  let entries = [];
  try { entries = await fs.readdir(channelsRoot(rootDir), { withFileTypes: true }); } catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
  const channels = (await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) => readGroupChannel({ rootDir, id: entry.name })))).filter(Boolean);
  return channels.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

export async function appendGroupChannelTurn({ rootDir, conversationStore = null, channelId, role, content, runId = null, metadata = {} } = {}) {
  const channel = await readGroupChannel({ rootDir, id: channelId });
  if (!channel) throw new Error('group_channel_not_found');
  if (!conversationStore) throw new Error('conversation_store_required');
  const entry = await conversationAuthority({ store: conversationStore, agentId: 'group-channel' }).append({ sessionId: channelId, type: 'message', role, content, runId, metadata: { kind: 'group-channel', channelId, ...metadata }, visibility: 'chat', entersPrompt: false });
  channel.updatedAt = entry.ts;
  await fs.writeFile(metaFile(rootDir, channelId), `${JSON.stringify(channel, null, 2)}\n`, 'utf8');
  return entry;
}

export async function readGroupChannelTurns({ rootDir, conversationStore = null, channelId, limit = 200 } = {}) {
  const channel = await readGroupChannel({ rootDir, id: channelId });
  if (!channel) return null;
  if (!conversationStore) throw new Error('conversation_store_required');
  return { channel, turns: (await conversationAuthority({ store: conversationStore, agentId: 'group-channel' }).entries(channelId, { limit })).filter(entry => entry.type === 'message') };
}
