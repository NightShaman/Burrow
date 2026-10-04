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

const metadataWrites = new Map();
async function atomicMetadata(file, channel) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, `${JSON.stringify(channel, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    await fs.rename(temp, file);
  } finally { await fs.rm(temp, { force: true }).catch(() => {}); }
}
async function updateMetadata(rootDir, channelId, ts) {
  const file = metaFile(rootDir, channelId);
  const previous = metadataWrites.get(file) || Promise.resolve();
  const pending = previous.catch(() => {}).then(async () => {
    const channel = await readGroupChannel({ rootDir, id: channelId });
    if (!channel) throw new Error('group_channel_not_found');
    channel.updatedAt = String(channel.updatedAt) > String(ts) ? channel.updatedAt : ts;
    await atomicMetadata(file, channel);
  });
  metadataWrites.set(file, pending);
  try { await pending; } finally { if (metadataWrites.get(file) === pending) metadataWrites.delete(file); }
}

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
  await atomicMetadata(metaFile(rootDir, channelId), channel);
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
  try {
    await updateMetadata(rootDir, channelId, entry.ts);
    return { ...entry, persistence: { message: 'persisted', metadata: 'updated' } };
  } catch (error) {
    // Never report a committed message as an append failure (callers may retry it).
    return { ...entry, persistence: { message: 'persisted', metadata: 'failed', error: String(error?.message || error) } };
  }
}

export async function readGroupChannelTurns({ rootDir, conversationStore = null, channelId, limit = 200, before = null } = {}) {
  const channel = await readGroupChannel({ rootDir, id: channelId });
  if (!channel) return null;
  if (!conversationStore) throw new Error('conversation_store_required');
  if (typeof conversationStore.readMessageTail === 'function') {
    const page = await conversationStore.readMessageTail({ agentId: 'group-channel', sessionId: channelId, limit, before });
    return { channel, turns: page.entries, olderCursor: page.olderCursor };
  }
  // Compatibility for injected stores: page the authority rather than silently returning an old prefix.
  const authority = conversationAuthority({ store: conversationStore, agentId: 'group-channel' });
  const initial = await authority.entries(channelId, { limit: 256 });
  const entries = (initial.some(entry => entry.sequence != null) ? await authority.entriesAll(channelId) : initial)
    .filter(entry => entry.type === 'message' && (before == null || BigInt(entry.sequence) < BigInt(before)));
  const size = Math.max(1, Math.min(1000, Math.floor(Number(limit) || 200)));
  const turns = entries.slice(-size);
  return { channel, turns, olderCursor: entries.length > size ? String(turns[0].sequence) : null };
}
