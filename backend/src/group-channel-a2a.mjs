import { readGroupChannel, readGroupChannelTurns, withGroupChannelAdmission } from './group-channel-store.mjs';

// Only runtime ingress mints these capabilities. Tool arguments, transcript text,
// and serialized request bodies cannot supply room authority.
const contexts = new WeakSet();
export function createGroupChannelContext(context) {
  const value = Object.freeze({ ...context, participantAgentIds: Object.freeze([...context.participantAgentIds]) });
  contexts.add(value);
  return value;
}
export function assertTrustedGroupChannelContext(context) {
  if (!contexts.has(context)) throw new Error('agent_message_room_context_untrusted');
}
export async function refreshGroupChannelContext(context, { conversationStore, sender, recipient }) {
  assertTrustedGroupChannelContext(context);
  const room = await readGroupChannelTurns({ ...context, conversationStore, limit: 500 });
  assertMembers(room?.channel, sender, recipient);
  return createGroupChannelContext({ ...context, channelName: room.channel.name,
    participantAgentIds: room.channel.participantAgentIds, turns: room.turns.filter(turn => turn.metadata?.replyEntersPrompt !== false) });
}
function assertMembers(channel, sender, recipient) {
  if (!channel) throw new Error('group_channel_not_found');
  if (![sender, recipient].every(id => channel.participantAgentIds.includes(id))) throw new Error('agent_message_room_membership_required');
}
export async function assertGroupChannelMembers(context, sender, recipient) {
  assertMembers(await readGroupChannel({ rootDir: context.rootDir, id: context.channelId }), sender, recipient);
}
export async function appendGroupChannelA2A(context, { conversationStore, sender, recipient, ...turn }) {
  assertTrustedGroupChannelContext(context);
  return withGroupChannelAdmission(context, async ({ appendTurn }) => {
    await assertGroupChannelMembers(context, sender, recipient);
    return appendTurn({ ...turn, conversationStore });
  });
}
