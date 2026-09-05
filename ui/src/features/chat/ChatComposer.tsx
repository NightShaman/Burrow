import { useEffect, useState } from 'react';
import type { ChangeEvent, ClipboardEvent, DragEvent, KeyboardEvent } from 'react';
import { api, textFromChatValue, type ChatAttachment, type SessionTurn } from '../../app/api';

const CHAT_COMMANDS = [
  { name: 'help', usage: '/help', description: 'List available chat commands.' },
  { name: 'context', usage: '/context [full]', description: 'Show context capacity, or the full provider context.' },
  { name: 'status', usage: '/status', description: 'Show runtime and active-run status.' },
  { name: 'new', usage: '/new', description: 'Start a fresh conversation generation.' },
  { name: 'stop', usage: '/stop', description: 'Cancel the active run in this session.' },
  { name: 'project', usage: '/project [name]', description: 'Set or clear the active project.' },
] as const;

function commandQuery(value: string) {
  const match = value.match(/^\/([A-Za-z0-9_-]*)$/u);
  return match ? match[1].toLowerCase() : null;
}

type ChatComposerProps = {
  draft: string;
  setDraft: (value: string) => void;
  attached: ChatAttachment[];
  onAttach: (files: File[]) => void;
  onRemoveAttachment: (index: number) => void;
  disabled?: boolean;
  onSend: () => void;
  onCancel?: () => void;
  placeholder: string;
  onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  conversationTurns?: SessionTurn[];
};

export function ChatComposer({
  draft,
  setDraft,
  attached,
  onAttach,
  onRemoveAttachment,
  disabled = false,
  onSend,
  onCancel,
  placeholder,
  onKeyDown,
  conversationTurns = [],
}: ChatComposerProps) {
  const canSend = Boolean(draft.trim() || attached.length) && !disabled;
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const query = commandQuery(draft.trim());
  const commandMatches = query === null ? [] : CHAT_COMMANDS.filter((command) => command.name.startsWith(query));
  const projectQuery = /^\/project(?:\s+(.*))?$/iu.exec(draft.trim())?.[1] ?? null;
  const [projects, setProjects] = useState<Array<{ id: string; name: string; description?: string }>>([]);
  useEffect(() => {
    if (projectQuery === null) return;
    void api<{ projects: Array<{ id: string; name: string; description?: string }> }>('/api/task-board/projects').then((result) => setProjects(result.projects)).catch(() => setProjects([]));
  }, [projectQuery === null]);
  const visibleProjects = projectQuery === null ? [] : projects.filter((project) => !projectQuery || project.name.toLowerCase().includes(projectQuery.toLowerCase()));
  const chooseCommand = (name: string) => setDraft(`/${name}${name === 'context' ? ' ' : ''}`);
  const pasteImages = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith('image/'));
    if (files.length) {
      event.preventDefault();
      onAttach(files);
    }
  };
  const chooseFiles = (event: ChangeEvent<HTMLInputElement>) => {
    onAttach(Array.from(event.target.files ?? []));
    event.target.value = '';
  };
  const dropFiles = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    onAttach(Array.from(event.dataTransfer.files));
  };
  const copyConversation = async () => {
    const transcript = conversationTurns
      .filter((turn) => textFromChatValue(turn.content).trim())
      .map((turn) => `${['user', 'operator', 'human'].includes((turn.role ?? '').toLowerCase()) ? 'You' : 'Assistant'} — ${formatTimestamp(turn.ts)}\n${textFromChatValue(turn.content)}`)
      .join('\n\n');
    if (!transcript) return;
    const didCopy = await copyMarkdown(transcript);
    setCopyState(didCopy ? 'copied' : 'failed');
    window.setTimeout(() => setCopyState('idle'), 1800);
  };

  return (
    <div className="composer-wrap" onDragOver={(event) => event.preventDefault()} onDrop={dropFiles}>
      {attached.length > 0 && (
        <div className="attachment-list" aria-label={`${attached.length} attachment${attached.length === 1 ? '' : 's'}`}>
          {attached.map((file, index) => (
            <button className="attachment" key={`${file.name}-${index}`} onClick={() => onRemoveAttachment(index)} aria-label={`Remove ${file.name}`} title={file.type.startsWith('image/') ? undefined : file.name}>
              {file.type.startsWith('image/') ? <img className="attachment-preview" src={file.content} alt="" /> : null}
              <span className="attachment-meta">{file.type.startsWith('image/') ? null : <span className="attachment-name">{file.name}</span>}<span aria-hidden="true">×</span></span>
            </button>
          ))}
        </div>
      )}
      {commandMatches.length > 0 && (
        <div className="chat-command-menu" role="listbox" aria-label="Chat commands">
          {commandMatches.map((command) => <button key={command.name} type="button" role="option" onMouseDown={(event) => event.preventDefault()} onClick={() => chooseCommand(command.name)}><strong>{command.usage}</strong><span>{command.description}</span></button>)}
        </div>
      )}
      {projectQuery !== null && (
        <div className="chat-command-menu" role="listbox" aria-label="Projects">
          <button type="button" role="option" onMouseDown={(event) => event.preventDefault()} onClick={() => setDraft('/project clear')}><strong>Clear active project</strong><span>Remove project context from this conversation.</span></button>
          {visibleProjects.map((project) => <button key={project.id} type="button" role="option" onMouseDown={(event) => event.preventDefault()} onClick={() => setDraft(`/project ${project.name}`)}><strong>{project.name}</strong><span>{project.description || 'TaskBoard project'}</span></button>)}
        </div>
      )}
      <div className="composer">
        <textarea id="chat-message" name="message" aria-label="Message" value={draft} onChange={(event) => setDraft(event.target.value)} onPaste={pasteImages} onKeyDown={(event) => { onKeyDown?.(event); if (event.defaultPrevented) return; if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); onSend(); } }} placeholder={placeholder} />
        <div className="compose-footer"><div className="compose-actions">
          <button className="copy-conversation" onClick={() => void copyConversation()} disabled={!conversationTurns.some((turn) => textFromChatValue(turn.content).trim())} aria-label={copyState === 'copied' ? 'Conversation copied' : 'Copy conversation'} title={copyState === 'copied' ? 'Conversation copied' : copyState === 'failed' ? 'Copy failed' : 'Copy conversation'}>{copyState === 'copied' ? '✓' : '⧉'}</button>
          <label className="attach" aria-label="Attach image or document" title="Attach image or document"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m20.5 11.5-8.7 8.7a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7L9 17.4a2 2 0 0 1-2.8-2.8l8.2-8.2" /></svg><input id="chat-attachments" name="attachments" type="file" multiple accept="image/*,text/*,.txt,.md,.markdown,.json,.csv,.xml,.html,.css,.js,.ts,.tsx,.jsx,.py,.rb,.go,.rs,.java,.c,.cpp,.h,.yaml,.yml,.rtf" onChange={chooseFiles} /></label>
          {disabled && onCancel ? <button className="send stop" onClick={onCancel} aria-label="Stop response" title="Stop response">■</button> : <button className="send" onMouseDown={(event) => event.preventDefault()} onClick={onSend} disabled={!canSend} aria-label="Send message" title="Send message"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 3 18 9-18 9 4-9-4-9Z" /><path d="M7 12h14" /></svg></button>}
        </div></div>
      </div>
    </div>
  );
}

function formatTimestamp(value?: string) { if (!value) return 'Now'; const date = new Date(value); return Number.isNaN(date.getTime()) ? 'Now' : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date); }
async function copyMarkdown(text: string) { try { if (navigator.clipboard?.writeText && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; } } catch {} const textarea = document.createElement('textarea'); textarea.value = text; textarea.setAttribute('readonly', ''); textarea.style.cssText = 'position:fixed;opacity:0;pointer-events:none'; document.body.append(textarea); textarea.select(); const copied = document.execCommand('copy'); textarea.remove(); return copied; }
