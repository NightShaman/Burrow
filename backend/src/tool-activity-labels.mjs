import path from 'node:path';

function compactDetail(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 160);
}

function basename(value = '') {
  return path.basename(String(value || ''));
}

export function toolActivityPresentation(input = {}) {
  const payload = input.payload || input;
  const tool = String(payload.tool || '').trim();
  // Identity only: never derive MCP/skill presentation from arguments or bodies.
  if (tool === 'mcp_call') {
    const provider = compactDetail(payload.provider || payload.mcpProvider);
    const name = compactDetail(payload.mcpToolName);
    return { label: name ? `MCP ${provider ? `${provider} / ` : ''}${name}` : 'MCP call' };
  }
  if (tool === 'load_skill') {
    const id = compactDetail(payload.skillId || payload.skill?.id);
    const name = compactDetail(payload.skillName || payload.skill?.name);
    return { label: `Loading skill${name || id ? ` ${name || id}` : ''}`, ...(id && name && id !== name ? { detail: id } : {}) };
  }
  const filePath = payload.filePath || payload.path || '';
  const dirPath = payload.dirPath || '';
  const query = payload.query || payload.pattern || '';
  const command = String(payload.command || '').trim();
  if (!tool && !filePath && !command) return null;

  const commandFile = [...command.matchAll(/([^\s'";&|]+\.(?:tsx|ts|jsx|js|mjs|cjs|json|md|css|html|yaml|yml))/gi)].at(-1)?.[1] || '';
  const label = tool === 'files_read' && filePath
    ? `Reading ${basename(filePath)}`
    : (tool === 'files_write' || tool === 'files_edit' || tool === 'files_patch') && filePath
      ? `Updating ${basename(filePath)}`
      : tool === 'files_list'
        ? 'Listing files'
        : tool === 'files_find'
          ? 'Finding files'
          : tool === 'files_inspect'
            ? 'Checking path'
            : tool === 'files_search'
              ? 'Searching files'
              : tool === 'git_status'
                ? 'Checking repository'
                : tool === 'git_diff'
                  ? 'Reviewing changes'
                  : tool === 'shell_exec' && /(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:check|test|lint|build)|\b(?:check|test|lint|build)\b/i.test(command)
                    ? 'Running checks'
                    : tool === 'shell_exec' && /\bgit\s+(?:status|log|branch)\b/i.test(command)
                      ? 'Checking repository'
                      : tool === 'shell_exec' && /\bgit\s+diff\b/i.test(command)
                        ? 'Reviewing changes'
                        : tool === 'shell_exec' && /\b(?:sed|cat|head|tail|less)\b/i.test(command) && commandFile
                          ? `Reading ${basename(commandFile)}`
                          : tool === 'shell_exec' && /\b(?:ls|find|rg|grep)\b/i.test(command)
                            ? 'Inspecting files'
                            : tool === 'shell_exec'
                              ? 'Running a task'
                              : tool || 'Working';

  const detail = compactDetail(filePath || dirPath || (query ? `query: ${query}` : '') || command || payload.error || '');
  return { label, ...(detail ? { detail } : {}) };
}

export function toolActivityStatus({ card = {}, payload = {} } = {}) {
  if (card.status === 'failed' || payload.ok === false) return 'error';
  if (card.status === 'ok' || payload.ok === true) return 'ok';
  return 'pending';
}
