import { useEffect, useRef, useState } from 'react';
import type { ClaudeCodeLogin } from './modelConnectionsApi';
import type { useClaudeCodeLoginFlow } from './useClaudeCodeLoginFlow';
import type { useOpenAiOAuthConnectionFlow } from './useOpenAiOAuthConnectionFlow';
import { Field } from './SettingsPrimitives';

const finalClaudeLoginStatuses = new Set(['imported', 'cancelled', 'expired', 'failed']);
const claudeLoginCanSubmitCode = (login?: ClaudeCodeLogin | null) => login?.status === 'waiting_for_code';
const claudeLoginCanImport = (login?: ClaudeCodeLogin | null) => login ? ['authorized', 'ready_to_import'].includes(login.status) : false;

export const openAiLoginStatusLabel = (status?: string) => {
  switch (status) {
    case 'starting': return 'Preparing secure sign-in';
    case 'waiting_for_callback': return 'Finish signing in in your browser';
    case 'waiting_for_code': return 'Paste the sign-in callback to continue';
    case 'exchanging': return 'Confirming your sign-in';
    case 'authorized': return 'Signed in';
    case 'completed': case 'imported': return 'Connected';
    case 'cancelled': return 'Sign-in cancelled';
    case 'expired': return 'Sign-in expired';
    case 'failed': return 'Sign-in failed';
    default: return status ? status.replace(/[-_]+/g, ' ') : 'Ready to sign in';
  }
};

export const claudeLoginStatusLabel = (status?: string) => {
  switch (status) {
    case 'waiting_for_code': return 'Waiting for callback code';
    case 'code_submitted': return 'Code submitted';
    case 'authorizing': return 'Authorizing';
    case 'authorized': return 'Authorized';
    case 'ready_to_import': return 'Ready to import';
    case 'imported': return 'Imported';
    case 'cancelled': return 'Cancelled';
    case 'expired': return 'Expired';
    case 'failed': return 'Failed';
    case 'waiting_for_url': return 'Starting Claude Code';
    default: return status ? status.replace(/[-_]+/g, ' ') : 'Idle';
  }
};

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall back for local HTTP */ }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  return copied;
}

type OpenAiFlow = ReturnType<typeof useOpenAiOAuthConnectionFlow>;
type ClaudeFlow = ReturnType<typeof useClaudeCodeLoginFlow>;

type Props = {
  kind: 'openai' | 'anthropic';
  editingId: string | null;
  apiType: string;
  onClose: () => void;
  openAi: OpenAiFlow;
  claude: ClaudeFlow;
};

export function ModelConnectionOAuthDialog({ kind, editingId, apiType, onClose, openAi, claude }: Props) {
  const [copiedLoginUrl, setCopiedLoginUrl] = useState<'openai' | 'anthropic' | null>(null);
  const copiedTimer = useRef<number | null>(null);
  useEffect(() => () => { if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current); }, []);

  const copyLoginUrl = async (loginKind: 'openai' | 'anthropic', loginUrl: string) => {
    const copied = await copyText(loginUrl);
    if (!copied) {
      const message = 'Could not copy the login URL. Select it and copy it manually.';
      if (loginKind === 'openai') openAi.setError(message); else claude.setError(message);
      return;
    }
    setCopiedLoginUrl(loginKind);
    if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    copiedTimer.current = window.setTimeout(() => setCopiedLoginUrl((current) => current === loginKind ? null : current), 2_000);
  };

  return <div className="oauth-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="oauth-modal" role="dialog" aria-modal="true" aria-labelledby="oauth-modal-title">
      <div className="oauth-modal-header"><div><span className="eyebrow">AUTHENTICATION</span><h2 id="oauth-modal-title">{kind === 'openai' ? 'OpenAI OAuth' : 'Anthropic OAuth'}</h2></div><button className="modal-close" type="button" aria-label="Close OAuth dialog" onClick={onClose}>×</button></div>
      {kind === 'openai' ? <>
        <p className="oauth-helper">Uses OpenAI OAuth PKCE. Stores encrypted OAuth credentials.</p>
        <div className="claude-login-actions"><button className="secondary" type="button" onClick={() => void openAi.start()} disabled={openAi.requestState !== 'idle'}>{openAi.requestState === 'starting' ? 'Starting…' : 'Sign in with ChatGPT'}</button>{openAi.login && !['completed', 'imported', 'cancelled', 'expired', 'failed'].includes(openAi.login.status) && <button className="secondary" type="button" onClick={() => void openAi.cancel()} disabled={openAi.requestState !== 'idle'}>{openAi.requestState === 'cancelling' ? 'Cancelling…' : 'Cancel login'}</button>}</div>
        {openAi.login && <div className={`claude-login-status ${['failed', 'expired'].includes(openAi.login.status) ? 'error' : ''}`}><span>{openAiLoginStatusLabel(openAi.login.status)}</span>{openAi.login.expiresAt && <small>Expires {new Date(openAi.login.expiresAt).toLocaleString()}</small>}{openAi.login.error && <small>{openAi.login.error}</small>}</div>}
        {openAi.login?.authorizationUrl && <div className="claude-login-url"><input readOnly value={openAi.login.authorizationUrl} aria-label="ChatGPT authorization URL" /><button className="secondary" type="button" onClick={() => void copyLoginUrl('openai', openAi.login?.authorizationUrl ?? '')}>{copiedLoginUrl === 'openai' ? 'Copied' : 'Copy URL'}</button><a className="secondary" href={openAi.login.authorizationUrl} target="_blank" rel="noreferrer">Open URL</a></div>}
        <div className="claude-code-entry"><Field label="Callback code or URL"><textarea value={openAi.code} onChange={(event) => openAi.setCode(event.target.value)} placeholder="Paste the ChatGPT callback code or redirect URL here" rows={3} /></Field><button className="primary" type="button" onClick={() => void openAi.submit()} disabled={!openAi.code.trim() || openAi.requestState !== 'idle'}>{openAi.requestState === 'submitting' ? 'Submitting…' : 'Submit callback'}</button></div>
        {openAi.error && <p className="settings-request-error" role="alert">{openAi.error}</p>}
      </> : <>
        <p className="oauth-helper">Use Claude Code OAuth for this Anthropic connection.</p>
        {!editingId && <p className="claude-login-note">Save this connection, then edit it to import Claude Code auth.</p>}
        <div className="claude-login-actions"><button className="secondary" type="button" onClick={() => { if (apiType === 'anthropic-messages') void claude.start(editingId ?? undefined); }} disabled={claude.requestState !== 'idle'}>{claude.requestState === 'starting' ? 'Starting…' : 'Start Claude Code login'}</button>{claude.login && !finalClaudeLoginStatuses.has(claude.login.status) && <button className="secondary" type="button" onClick={() => void claude.cancel()} disabled={claude.requestState !== 'idle'}>{claude.requestState === 'cancelling' ? 'Cancelling…' : 'Cancel login'}</button>}</div>
        {claude.login && <div className={`claude-login-status ${['failed', 'expired'].includes(claude.login.status) ? 'error' : ''}`}><span>Status: {claudeLoginStatusLabel(claude.login.status)}</span>{claude.login.expiresAt && <small>Expires {new Date(claude.login.expiresAt).toLocaleString()}</small>}{claude.login.error && <small>{claude.login.error}</small>}</div>}
        {claude.login?.verificationUrl && <div className="claude-login-url"><input readOnly value={claude.login.verificationUrl} aria-label="Claude login URL" /><button className="secondary" type="button" onClick={() => void copyLoginUrl('anthropic', claude.login?.verificationUrl ?? '')}>{copiedLoginUrl === 'anthropic' ? 'Copied' : 'Copy URL'}</button><a className="secondary" href={claude.login.verificationUrl} target="_blank" rel="noreferrer">Open URL</a></div>}
        {claudeLoginCanSubmitCode(claude.login) && <div className="claude-code-entry"><Field label="Callback code"><textarea value={claude.code} onChange={(event) => claude.setCode(event.target.value)} placeholder="Paste the Claude callback code here" rows={3} /></Field><button className="primary" type="button" onClick={() => void claude.submit()} disabled={!claude.code.trim() || claude.requestState !== 'idle'}>{claude.requestState === 'submitting' ? 'Submitting…' : 'Submit code'}</button></div>}
        {claudeLoginCanImport(claude.login) && <button className="primary" type="button" onClick={() => void claude.importCredentials()} disabled={claude.requestState !== 'idle'}>{claude.requestState === 'importing' ? 'Importing…' : 'Import Claude auth'}</button>}
        {claude.error && <p className="settings-request-error" role="alert">{claude.error}</p>}
      </>}
    </div>
  </div>;
}
