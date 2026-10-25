/** Only explicit identity metadata belongs in MCP/skill activity, never payloads. */
export function chatToolIdentity(data: { tool?: unknown; provider?: unknown; mcpToolName?: unknown; skillId?: unknown; skillName?: unknown; version?: unknown }) {
  const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
  const tool = text(data.tool);
  if (tool === 'mcp_call') {
    const identity = [text(data.provider), text(data.mcpToolName)].filter(Boolean).join(' · ');
    return { label: identity ? `MCP · ${identity}` : 'MCP call', detail: identity || undefined };
  }
  if (tool === 'load_skill') {
    const id = text(data.skillId);
    const name = text(data.skillName);
    const identity = [name, id && id !== name ? id : ''].filter(Boolean).join(' · ');
    return { label: identity ? `Load skill · ${identity}` : 'Load skill', detail: [identity, text(data.version)].filter(Boolean).join(' · ') || undefined };
  }
  return undefined;
}
