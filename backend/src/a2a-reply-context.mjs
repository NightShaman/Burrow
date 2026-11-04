// Request-local transport facts, shared by ordinary and mod-owned agents.
export function a2aReplyMechanics(incomingAgentMessage = null) {
  const mode = incomingAgentMessage?.messageMode || (incomingAgentMessage ? 'request_reply' : '');
  return ['request_reply', 'request_reply_complete'].includes(mode)
    ? 'Active A2A reply mechanics: You are responding as yourself to the attributed sending agent, not as the operator or the sender. Your final answer is automatically delivered back to that agent by this exchange. Answer this request in your final response; do not send the same answer separately with agent_send_message. The messaging tool remains available for distinct progress updates, deliberate follow-up questions, and messages to other peers. Do not repeat an already-sent answer in your final response.'
    : '';
}
