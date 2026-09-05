export const CHAT_COMMANDS = Object.freeze([
  Object.freeze({ name: 'help', usage: '/help', description: 'List available chat commands.' }),
  Object.freeze({ name: 'context', usage: '/context [full]', description: 'Show context capacity, or the full role-structured provider context for the current session meter.' }),
  Object.freeze({ name: 'status', usage: '/status', description: 'Show compact runtime and active-run status.' }),
  Object.freeze({ name: 'new', usage: '/new', description: 'Start a fresh conversation generation in this session; prior history is archived.' }),
  Object.freeze({ name: 'stop', usage: '/stop', description: 'Cancel the active run in this session.' }),
]);

const BY_NAME = new Map(CHAT_COMMANDS.map((command) => [command.name, command]));

export function parseChatCommand(message = '') {
  const text = String(message || '');
  if (!text.startsWith('/')) return null;
  const match = /^\/([A-Za-z][A-Za-z0-9_-]*)(?:\s+(.*))?\s*$/u.exec(text);
  if (!match) return { command: null, args: '', error: 'command_invalid' };
  const command = match[1].toLowerCase();
  return { command, args: String(match[2] || '').trim(), definition: BY_NAME.get(command) || null, error: null };
}

export function chatCommandHelpText() {
  return ['Available commands:', ...CHAT_COMMANDS.map((command) => `- ${command.usage} — ${command.description}`)].join('\n');
}

export function chatCommandResponse({ command, sessionId, text, receipt = {}, ok = true } = {}) {
  return {
    ok,
    command: { name: command || null, sessionId: sessionId || 'default', ...receipt },
    summary: { command: command || null, sessionId: sessionId || 'default' },
    result: { command: command || null, sessionId: sessionId || 'default', answerText: text || '', commandReceipt: receipt },
  };
}
