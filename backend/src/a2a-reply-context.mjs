// Request-local transport facts, shared by ordinary and mod-owned agents.
export function a2aReplyMechanics(incomingAgentMessage = null, groupChannel = null) {
  const mode = incomingAgentMessage?.messageMode || (incomingAgentMessage ? 'request_reply' : '');
  return ['request_reply', 'request_reply_complete'].includes(mode)
    ? groupChannel?.channelId
      ? 'Active room A2A reply: Answer the request as yourself in your final response. The runtime posts it directly to the shared room under your name. Address the room and the operator who can see the exchange. Use agent_send_message for distinct messages only.'
      : 'Active A2A reply mechanics: You are responding as yourself to the attributed sending agent, not as the operator or the sender. Your final answer is automatically delivered back to that agent by this exchange. Answer this request in your final response; do not send the same answer separately with agent_send_message. The messaging tool remains available for distinct progress updates, deliberate follow-up questions, and messages to other peers. Do not repeat an already-sent answer in your final response.'
    : '';
}
