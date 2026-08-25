import React, { useEffect, useRef, useState } from 'react';
import type { Agent, SavedProvider } from '../../app/types';
import { api, importExport, type RuntimeModel } from '../../app/api';
import type { ClaudeCodeLogin, OpenAiOAuthConnection } from './modelConnectionsApi';
import { useClaudeCodeLoginFlow } from './useClaudeCodeLoginFlow';
import { useOpenAiOAuthConnectionFlow } from './useOpenAiOAuthConnectionFlow';

const profileDocumentKinds = ['SOUL', 'RULES', 'ORIENTATION', 'TOOLS', 'DREAM_MEMORY'] as const;

const finalClaudeLoginStatuses = new Set(['imported', 'cancelled', 'expired', 'failed']);
const claudeLoginCanSubmitCode = (login?: ClaudeCodeLogin | null) => login?.status === 'waiting_for_code';
const selectedRuntimeModels = (models: Array<string | RuntimeModel> = []): RuntimeModel[] => models.map((model) => {
  if (typeof model === 'string') return { id: model, selected: true, acceptedInput: ['text'] };
  return { ...model, selected: model.selected ?? true, acceptedInput: model.acceptedInput ?? model.discoveredInput ?? ['text'] };
});

const savedProviderFromConnection = (connection: OpenAiOAuthConnection): SavedProvider => {
 const models = selectedRuntimeModels(connection.models);
 return {
  id: connection.id,
  provider: connection.provider ?? 'OpenAI',
  apiType: connection.apiType ?? 'openai-responses',
  url: connection.baseUrl ?? 'https://chatgpt.com/backend-api',
  apiKey: '',
  models: models.map((model) => model.id),
  manualModels: Object.fromEntries(models.filter((model) => model.manual).map((model) => [model.id, true])),
  modelLabels: Object.fromEntries(models.filter((model) => model.displayName).map((model) => [model.id, model.displayName!])),
  modelEfforts: Object.fromEntries(models.filter((model) => model.reasoningEfforts?.length).map((model) => [model.id, model.reasoningEfforts!])),
  defaultEfforts: Object.fromEntries(models.filter((model) => model.defaultReasoningEffort).map((model) => [model.id, model.defaultReasoningEffort!])),
  modelContextWindows: Object.fromEntries(models.filter((model) => model.contextWindow).map((model) => [model.id, model.contextWindow!])),
  modelDiscoveredInputs: Object.fromEntries(models.filter((model) => model.discoveredInput?.length).map((model) => [model.id, model.discoveredInput!])),
  modelInputOverrides: Object.fromEntries(models.filter((model) => model.acceptedInputOverride?.length).map((model) => [model.id, model.acceptedInputOverride!])),
 };
};

const agentIdFromName = (name: string) => name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
const importErrorMessage = (cause: unknown) => cause instanceof Error && cause.message === 'import_password_required' ? 'Password required.' : cause instanceof Error ? `Could not import export: ${cause.message}` : 'Could not import export.';

const openAiLoginStatusLabel = (status?: string) => {
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

const claudeLoginStatusLabel = (status?: string) => {
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

const MAX_AVATAR_FILE_SIZE = 2_000_000;
const MAX_AVATAR_DATA_URL_SIZE = 512_000;
const AVATAR_MAX_DIMENSION = 512;

async function optimizeAvatar(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('Choose or paste an image file for the avatar.');
  if (file.size > MAX_AVATAR_FILE_SIZE) throw new Error('Avatar image is too large. Maximum file size is 2 MB.');

  const source = await new Promise<HTMLImageElement>((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read the avatar image.')); };
    image.src = url;
  });
  const scale = Math.min(1, AVATAR_MAX_DIMENSION / Math.max(source.naturalWidth, source.naturalHeight));
  let width = Math.max(1, Math.round(source.naturalWidth * scale));
  let height = Math.max(1, Math.round(source.naturalHeight * scale));
  const canvas = document.createElement('canvas');

  for (let attempt = 0; attempt < 6; attempt += 1) {
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not process the avatar image.');
    context.drawImage(source, 0, 0, width, height);
    for (const quality of [0.86, 0.72, 0.58]) {
      const avatar = canvas.toDataURL('image/webp', quality);
      if (avatar.length <= MAX_AVATAR_DATA_URL_SIZE) return avatar;
    }
    width = Math.max(1, Math.round(width * 0.75));
    height = Math.max(1, Math.round(height * 0.75));
  }
  throw new Error('Could not optimize the avatar image enough to save it.');
}
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="field">{label}{children}</label>; }

export type AgentToolbarProps = { agents: Agent[]; selectedId: string; onSelect: (id: string) => void; onAgentsChanged: () => Promise<void>; onModelConnectionsChanged: () => Promise<void>; onOperatorProfileChanged?: (profile: { name: string; avatar: string }) => void; onFirstRunComplete?: () => void; onSetupComplete?: () => Promise<void>; firstRun?: boolean };

export function AgentToolbar({ agents, selectedId, onSelect, onAgentsChanged, onModelConnectionsChanged, onOperatorProfileChanged, onFirstRunComplete, onSetupComplete, firstRun = false }: AgentToolbarProps) {
 const [showNewAgent, setShowNewAgent] = useState(false);
 const onFirstRunCompleteRef = useRef(onFirstRunComplete);
 const [step, setStep] = useState<1 | 2 | 3 | 4 | 5>(1);
 const [operatorName, setOperatorName] = useState(''); const [operatorAvatar, setOperatorAvatar] = useState(''); const [operatorAvatarFileName, setOperatorAvatarFileName] = useState('');
 const [name, setName] = useState(''); const [avatar, setAvatar] = useState(''); const [soul, setSoul] = useState('');
 const [connectionId, setConnectionId] = useState(''); const [model, setModel] = useState(''); const [providers, setProviders] = useState<SavedProvider[]>([]);
 const [celebrating, setCelebrating] = useState(false); const [importing, setImporting] = useState(false); const [imported, setImported] = useState(false); const [importPayload, setImportPayload] = useState(''); const [importPassword, setImportPassword] = useState(''); const importInput = useRef<HTMLInputElement>(null);
 const [state, setState] = useState<'idle' | 'creating'>('idle'); const [error, setError] = useState(''); const avatarInput = useRef<HTMLInputElement>(null); const operatorAvatarInput = useRef<HTMLInputElement>(null);
 const [showRegularNewAgent, setShowRegularNewAgent] = useState(false); const [regularId, setRegularId] = useState(''); const [regularName, setRegularName] = useState(''); const [regularError, setRegularError] = useState(''); const [regularState, setRegularState] = useState<'idle' | 'creating'>('idle');
 const [oauthProvider, setOauthProvider] = useState<'openai' | 'anthropic' | null>(null);
 const [claudeConnection, setClaudeConnection] = useState<OpenAiOAuthConnection | null>(null);
 const wizardOAuthConnection = useRef<OpenAiOAuthConnection | null>(null);
 const saveWizardConnection = async (connection: OpenAiOAuthConnection) => {
  if (!connection.id || !connection.provider || !connection.apiType || !connection.baseUrl) throw new Error('OAuth completed, but the connection details were incomplete.');

  // The OAuth callback can report authorized before the saved connection has a model list.
  // Discover only after that authorization state, using its freshly stored OAuth credentials.
  const discovered = await api<{ models: RuntimeModel[] }>('/api/settings/model-connections/discover', {
   method: 'POST',
   headers: { 'content-type': 'application/json' },
   body: JSON.stringify({ id: connection.id, provider: connection.provider, apiType: connection.apiType, baseUrl: connection.baseUrl }),
  });
  const models = selectedRuntimeModels(discovered.models).map((item) => ({ ...item, selected: true }));
  if (!models.length) throw new Error('OAuth completed, but did not return any available models.');
  await api('/api/settings/model-connections', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: connection.id, provider: connection.provider, apiType: connection.apiType, baseUrl: connection.baseUrl, models }) });
  const result = await api<{ connections: OpenAiOAuthConnection[] }>('/api/settings/model-connections');
  setProviders((result.connections ?? []).map(savedProviderFromConnection));
  setConnectionId(connection.id);
  setModel(models[0]?.id ?? '');
 };
 const receiveWizardOAuthConnection = (connection: OpenAiOAuthConnection) => {
  wizardOAuthConnection.current = connection;
  setClaudeConnection(connection);
 };
 const completeWizardOAuth = async () => {
  if (!wizardOAuthConnection.current) throw new Error('OAuth completed, but the connection details were unavailable.');
  await saveWizardConnection(wizardOAuthConnection.current);
  setOauthProvider(null);
 };
 const { login: openAiLogin, code: openAiOAuthCode, setCode: setOpenAiOAuthCode, requestState: openAiOAuthState, error: openAiOAuthError, start: startOpenAiOAuth, submit: submitOpenAiOAuth, cancel: cancelOpenAiOAuth, reset: resetOpenAiOAuth } = useOpenAiOAuthConnectionFlow({ onConnection: receiveWizardOAuthConnection, onAuthorized: completeWizardOAuth });
 const { login: claudeLogin, code: claudeOAuthCode, setCode: setClaudeOAuthCode, requestState: claudeOAuthState, error: claudeOAuthError, start: startClaudeOAuth, submit: submitClaudeOAuth, cancel: cancelClaudeOAuth, reset: resetClaudeOAuth } = useClaudeCodeLoginFlow({ onConnection: receiveWizardOAuthConnection, onImported: completeWizardOAuth, autoImport: true });
 const oauthBusy = oauthProvider === 'openai' ? openAiOAuthState : oauthProvider === 'anthropic' ? claudeOAuthState : 'idle';
 const oauthError = oauthProvider === 'openai' ? openAiOAuthError : oauthProvider === 'anthropic' ? claudeOAuthError : '';
 const oauthCode = oauthProvider === 'openai' ? openAiOAuthCode : claudeOAuthCode;
 const setOauthCode = (code: string) => { if (oauthProvider === 'openai') setOpenAiOAuthCode(code); else setClaudeOAuthCode(code); };
 const startWizardOAuth = async (kind: 'openai' | 'anthropic') => {
  setOauthProvider(kind);
  wizardOAuthConnection.current = null;
  setClaudeConnection(null);
  resetOpenAiOAuth();
  resetClaudeOAuth();
  if (kind === 'openai') await startOpenAiOAuth(); else await startClaudeOAuth();
 };
 const submitWizardOAuth = async () => { if (oauthProvider === 'openai') await submitOpenAiOAuth(); else if (oauthProvider === 'anthropic') await submitClaudeOAuth(); };
 const cancelWizardOAuth = async () => { if (oauthProvider === 'openai') await cancelOpenAiOAuth(); else if (oauthProvider === 'anthropic') await cancelClaudeOAuth(); };
 const reset = () => { wizardOAuthConnection.current = null; setOauthProvider(null); setClaudeConnection(null); resetOpenAiOAuth(); resetClaudeOAuth(); setCelebrating(false); setShowNewAgent(false); setStep(1); setImportPayload(''); setImportPassword(''); setOperatorName(''); setOperatorAvatar(''); setOperatorAvatarFileName(''); setName(''); setAvatar(''); setSoul(''); setConnectionId(''); setModel(''); setError(''); setImporting(false); setImported(false); if (importInput.current) importInput.current.value = ''; };
 const open = async () => { setShowNewAgent(true); setStep(1); setError(''); try { const result = await api<{ connections: SavedProvider[] }>('/api/settings/model-connections'); setProviders(result.connections ?? []); } catch { setProviders([]); } };
 useEffect(() => {
   if (firstRun && !showNewAgent) void open();
 }, [firstRun, showNewAgent]);
 useEffect(() => { onFirstRunCompleteRef.current = onFirstRunComplete; }, [onFirstRunComplete]);
 useEffect(() => {
   if (!celebrating) return;
   const timer = window.setTimeout(() => { reset(); onFirstRunCompleteRef.current?.(); }, 5000);
   return () => window.clearTimeout(timer);
 }, [celebrating]);
 const openRegular = () => { setShowRegularNewAgent(true); setRegularId(''); setRegularName(''); setRegularError(''); };
 const closeRegular = () => { if (regularState === 'idle') { setShowRegularNewAgent(false); setRegularId(''); setRegularName(''); setRegularError(''); } };
 const createRegular = async () => { const nextId = regularId.trim(); const nextName = regularName.trim(); if (!nextId || !nextName) { setRegularError('An agent ID and display name are required.'); return; } setRegularState('creating'); setRegularError(''); try { const result = await api<{ agent: { id: string } }>('/api/agents', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: nextId, name: nextName, enabled: true }) }); await onAgentsChanged(); onSelect(result.agent.id); setShowRegularNewAgent(false); setRegularId(''); setRegularName(''); } catch (cause) { setRegularError(cause instanceof Error ? `Could not add agent: ${cause.message}` : 'Could not add agent.'); } finally { setRegularState('idle'); } };
 const chooseOperatorAvatar = async (file?: File) => { if (!file) return; try { setOperatorAvatar(await optimizeAvatar(file)); setOperatorAvatarFileName(file.name || 'Pasted image'); setError(''); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not process the avatar image.'); } };
 const chooseAvatar = async (file?: File) => { if (!file) return; try { setAvatar(await optimizeAvatar(file)); setError(''); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not process the avatar image.'); } };
 const pasteOperatorAvatar = (event: React.ClipboardEvent<HTMLDivElement>) => { const item = Array.from(event.clipboardData.items).find((clipboardItem) => clipboardItem.type.startsWith('image/')); const file = item?.getAsFile(); if (!file) return; event.preventDefault(); void chooseOperatorAvatar(file); };
 const pasteAvatar = (event: React.ClipboardEvent<HTMLDivElement>) => { const item = Array.from(event.clipboardData.items).find((clipboardItem) => clipboardItem.type.startsWith('image/')); const file = item?.getAsFile(); if (!file) return; event.preventDefault(); void chooseAvatar(file); };
 const removeOperatorAvatar = () => { setOperatorAvatar(''); setOperatorAvatarFileName(''); setError(''); if (operatorAvatarInput.current) operatorAvatarInput.current.value = ''; };
 const removeAvatar = () => { setAvatar(''); setError(''); if (avatarInput.current) avatarInput.current.value = ''; };
 const markSetupComplete = async () => {
  if (firstRun) await onSetupComplete?.();
};
 const skipFirstRun = async () => {
  setState('creating'); setError('');
  try { await markSetupComplete(); setCelebrating(true); }
  catch (cause) { setError(cause instanceof Error ? `Could not finish first-run setup: ${cause.message}` : 'Could not finish first-run setup.'); }
  finally { setState('idle'); }
 };
 const finish = async () => { const nextOperatorName = operatorName.trim(); const nextName = name.trim(); const nextId = agentIdFromName(nextName); if (!nextOperatorName) { setStep(2); setError('Your displayed name cannot be empty.'); return; } if (!nextName || !nextId) { setStep(3); setError('Enter an agent name containing at least one letter or number.'); return; } setState('creating'); setError(''); try { await api('/api/settings/identities', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'operator', id: 'default', name: nextOperatorName, avatar: operatorAvatar }) }); onOperatorProfileChanged?.({ name: nextOperatorName, avatar: operatorAvatar }); const result = await api<{ agent: { id: string } }>('/api/agents', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: nextId, name: nextName, enabled: true }) }); const agentId = result.agent.id; await Promise.all([api('/api/settings/identities', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'agent', id: agentId, name: nextName, avatar }) }), api(`/api/agents/${encodeURIComponent(agentId)}/profile-documents`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ documents: profileDocumentKinds.map(kind => ({ kind, markdown: kind === 'SOUL' ? soul : '' })) }) }), ...(connectionId && model ? [api(`/api/agents/${encodeURIComponent(agentId)}/model-selection`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ connectionId, model }) })] : [])]); await Promise.all([onModelConnectionsChanged(), onAgentsChanged()]); await markSetupComplete(); onSelect(agentId); setCelebrating(true); } catch (cause) { setError(cause instanceof Error ? `Could not finish first-run setup: ${cause.message}` : 'Could not finish first-run setup.'); } finally { setState('idle'); } };
 const provider = providers.find(item => item.id === connectionId);
 const readImportFile = async (file?: File) => {
  if (!file) return;
  setError(''); setImporting(true);
  try {
   let binary = ''; new Uint8Array(await file.arrayBuffer()).forEach(byte => { binary += String.fromCharCode(byte); });
   const payload = btoa(binary); setImportPayload(payload); setImportPassword('');
   const preview = await importExport({ payload }, true);
   if (preview.requiresPassword === true || preview.encrypted === true) { setImporting(false); return; }
   await importExport({ payload, confirm: true, conflictPolicy: 'replace' });
   await Promise.all([onModelConnectionsChanged(), onAgentsChanged()]); await markSetupComplete(); setImported(true); setCelebrating(true);
  } catch (cause) { setError(importErrorMessage(cause)); }
  finally { setImporting(false); }
 };
 const submitProtectedImport = async () => {
  if (!importPayload || !importPassword.trim()) { setError('Enter the password for this export.'); return; }
  setError(''); setImporting(true);
  try {
   await importExport({ payload: importPayload, password: importPassword, confirm: true, conflictPolicy: 'replace' });
   await Promise.all([onModelConnectionsChanged(), onAgentsChanged()]); await markSetupComplete(); setImported(true); setImportPassword(''); setImportPayload(''); setCelebrating(true);
  } catch (cause) { setError(importErrorMessage(cause)); }
  finally { setImporting(false); }
 };
 return <><div className="agent-toolbar" aria-label="Agent configuration selector"><button className="primary" type="button" onClick={() => agents.length === 0 || firstRun ? void open() : openRegular()}>New Agent</button><div className="agent-toolbar-selector" role="group" aria-label="Configured agents">{agents.map(agent => <button className={agent.id === selectedId ? 'active' : ''} type="button" onClick={() => onSelect(agent.id)} key={agent.id} aria-pressed={agent.id === selectedId}>{agent.name}</button>)}</div></div>{showRegularNewAgent && <div className="agent-modal-backdrop" role="presentation" onMouseDown={closeRegular}><section className="agent-modal" role="dialog" aria-modal="true" aria-labelledby="regular-new-agent-title" onMouseDown={event => event.stopPropagation()}><header><div><span className="eyebrow">AGENTS</span><h2 id="regular-new-agent-title">New Agent</h2></div><button className="agent-modal-close" type="button" aria-label="Close new agent" onClick={closeRegular} disabled={regularState !== 'idle'}>×</button></header><div className="agent-add-fields"><Field label="ID"><input autoFocus value={regularId} onChange={event => setRegularId(event.target.value)} placeholder="luna" pattern="[A-Za-z0-9._-]+" disabled={regularState !== 'idle'} /></Field><Field label="Name"><input value={regularName} onChange={event => setRegularName(event.target.value)} placeholder="Luna" maxLength={64} disabled={regularState !== 'idle'} /></Field>{regularError && <p className="settings-request-error" role="alert">{regularError}</p>}<footer><button className="secondary" type="button" onClick={closeRegular} disabled={regularState !== 'idle'}>Cancel</button><button className="primary" type="button" onClick={() => void createRegular()} disabled={regularState !== 'idle' || !regularId.trim() || !regularName.trim()}>{regularState === 'creating' ? 'Creating…' : 'Create agent'}</button></footer></div></section></div>}{showNewAgent && <div className={`agent-modal-backdrop${celebrating ? ' agent-wizard-celebrating' : ''}`} role="presentation" onMouseDown={() => state === 'idle' && !firstRun && !celebrating && reset()}>{celebrating ? <section className="agent-wizard-finale" role="status" aria-live="polite"><div className="wizard-confetti" aria-hidden="true">{Array.from({ length: 24 }, (_, index) => <i key={index} style={{ '--i': index } as React.CSSProperties} />)}</div><img src="/burrow-logo.png" alt="" /><span className="eyebrow">FIRST RUN COMPLETE</span><h2>{imported ? 'The kingdom is restored.' : 'You magnificent thing.'}</h2><p>{imported ? 'Your export has been imported. Everything is ready for your dramatic return.' : `${name || 'Your agent'} is ready for their dramatic entrance.`}</p><span className="wizard-finale-countdown">Entering Burrow…</span></section> : <section className="agent-modal agent-wizard" role="dialog" aria-modal="true" aria-labelledby="new-agent-title" onMouseDown={event => event.stopPropagation()}><div className="agent-wizard-atmosphere" aria-hidden="true"><img src="/burrow-logo.png" alt="" /></div><header><div><span className="eyebrow">BURROW · FIRST RUN · STEP {step} OF 5</span><h2 id="new-agent-title">{step === 1 ? 'Bring your kingdom with you' : step === 2 ? 'Set up your operator profile' : step === 3 ? 'Identify your first agent' : step === 4 ? 'Give them a personality' : 'Choose a model'}</h2><p className="agent-wizard-lede">{step === 1 ? 'Already have an export? Import it now and skip the setup dance.' : step === 2 ? 'Start with you. The agents can be dramatic later.' : step === 3 ? 'Start with a presence. You can shape the rest as you go.' : step === 4 ? 'Make them feel like someone, not something.' : 'Connect a model now, or keep moving and do it later.'}</p></div><button className="agent-modal-close" type="button" aria-label="Close new agent" onClick={reset} disabled={state !== 'idle' || firstRun}>×</button></header><div className="agent-wizard-body">{step === 1 && <div className="wizard-import-landing"><img src="/burrow-logo.png" alt="" /><h3>Restore from an export</h3><p>Bring back your agents, connections, and settings in one fabulous move.</p><input ref={importInput} className="avatar-file-input" type="file" accept=".json.gz,.gz,.hc-export,.tar,.bin,application/octet-stream,application/gzip" onChange={event => { void readImportFile(event.target.files?.[0]); event.currentTarget.value = ''; }} /><button className="primary" type="button" onClick={() => importInput.current?.click()} disabled={importing}>{importing ? 'Importing…' : 'Import export'}</button>{importPayload && <div className="wizard-import-password"><Field label="Export password"><input autoFocus type="password" value={importPassword} onChange={event => setImportPassword(event.target.value)} placeholder="Enter the export password" onKeyDown={event => { if (event.key === 'Enter') void submitProtectedImport(); }} /></Field><button className="secondary" type="button" onClick={() => void submitProtectedImport()} disabled={importing || !importPassword.trim()}>{importing ? 'Unlocking…' : 'Unlock and import'}</button></div>}<div className="wizard-import-divider"><span>or start fresh</span></div></div>}{step === 2 && <><div className="agent-wizard-avatar" onPaste={pasteOperatorAvatar}><div className="agent-avatar-preview" aria-label={`${operatorName || 'Operator'} avatar preview`}>{operatorAvatar ? <img src={operatorAvatar} alt="" /> : (operatorName.trim()[0] || '?').toUpperCase()}</div><div className="operator-profile-details"><div className="avatar-file-control"><label className="avatar-file-name">Operator image<input value={operatorAvatarFileName} placeholder="Paste an image or choose a file" readOnly aria-label="Operator avatar image" /></label><button className="secondary" type="button" onClick={() => operatorAvatarInput.current?.click()}>Choose image</button><input ref={operatorAvatarInput} className="avatar-file-input" type="file" accept="image/*" onChange={event => { void chooseOperatorAvatar(event.target.files?.[0]); event.currentTarget.value = ''; }} /></div>{operatorAvatar && <button className="avatar-remove" type="button" onClick={removeOperatorAvatar}>Remove image</button>}</div></div><Field label="Displayed name"><input autoFocus value={operatorName} onChange={event => setOperatorName(event.target.value)} placeholder="Your name" maxLength={64} /></Field></>}{step === 3 && <><div className="wizard-agent-fields"><Field label="Name"><input autoFocus value={name} onChange={event => setName(event.target.value)} placeholder="Luna" maxLength={64} /></Field></div><div className="agent-wizard-avatar" onPaste={pasteAvatar}><div className="agent-avatar-preview" aria-label={`${name || 'New agent'} avatar preview`}>{avatar ? <img src={avatar} alt="" /> : (name.trim()[0] || '?').toUpperCase()}</div><div className="operator-profile-details"><div className="avatar-file-control"><label className="avatar-file-name">Avatar image<input value={avatar ? 'Image attached' : ''} placeholder="Paste an image or choose a file" readOnly aria-label="Avatar image" /></label><button className="secondary" type="button" onClick={() => avatarInput.current?.click()}>Choose image</button><input ref={avatarInput} className="avatar-file-input" type="file" accept="image/*" onChange={event => { void chooseAvatar(event.target.files?.[0]); event.currentTarget.value = ''; }} /></div>{avatar && <button className="avatar-remove" type="button" onClick={removeAvatar}>Remove image</button>}</div></div></>}{step === 4 && <Field label="SOUL.md"><textarea autoFocus value={soul} onChange={event => setSoul(event.target.value)} rows={8} placeholder="Who is this agent?" /></Field>}{step === 5 && <><p className="settings-description">Connect a chat model now, or finish and configure it later. This is not required.</p><div className="oauth-shortcuts wizard-oauth-shortcuts"><button className="oauth-trigger" type="button" onClick={() => void startWizardOAuth('openai')}><span>OpenAI</span><small>Sign in with ChatGPT</small></button><button className="oauth-trigger" type="button" onClick={() => void startWizardOAuth('anthropic')}><span>Anthropic</span><small>Claude Code login</small></button></div>{providers.length > 0 && <><Field label="Connection"><select value={connectionId} onChange={event => { setConnectionId(event.target.value); setModel(''); }}><option value="">Skip for now</option>{providers.map(item => <option key={item.id} value={item.id}>{item.provider}</option>)}</select></Field>{provider && <Field label="Model"><select value={model} onChange={event => setModel(event.target.value)}><option value="">Select a model</option>{provider.models.map(item => <option key={item} value={item}>{item}</option>)}</select></Field>}</>}{oauthProvider && <div className="oauth-modal-backdrop" role="presentation"><section className="oauth-modal" role="dialog" aria-modal="true" aria-labelledby="wizard-oauth-title"><div className="oauth-modal-header"><div><span className="eyebrow">CONNECT A MODEL</span><h2 id="wizard-oauth-title">{oauthProvider === 'openai' ? 'OpenAI OAuth' : 'Anthropic OAuth'}</h2></div><button className="modal-close" type="button" aria-label="Close OAuth dialog" onClick={() => oauthBusy === 'idle' && setOauthProvider(null)}>×</button></div>{oauthProvider === 'openai' ? <><p className="oauth-helper">Sign in with ChatGPT, then paste the callback URL or code below. We’ll save the connection with every available model selected.</p>{openAiLogin?.authorizationUrl && <a className="primary oauth-login-link" href={openAiLogin.authorizationUrl} target="_blank" rel="noreferrer">Open ChatGPT sign-in</a>}</> : <><p className="oauth-helper">Complete the Claude Code login, then paste its callback code. Available models will be selected and saved automatically.</p>{claudeLogin?.verificationUrl && <a className="primary oauth-login-link" href={claudeLogin.verificationUrl} target="_blank" rel="noreferrer">Open Claude sign-in</a>}</>}<p className="oauth-status" role="status">{oauthProvider === 'openai' ? openAiLoginStatusLabel(openAiLogin?.status ?? (oauthBusy === 'starting' ? 'starting' : undefined)) : claudeLoginStatusLabel(claudeLogin?.status ?? (oauthBusy === 'starting' ? 'waiting_for_url' : undefined))}</p><Field label={oauthProvider === 'openai' ? 'Callback URL or code' : 'Callback code'}><input autoFocus value={oauthCode} onChange={event => setOauthCode(event.target.value)} /></Field><div className="claude-login-actions"><button className="primary" type="button" disabled={!oauthCode.trim() || oauthBusy !== 'idle'} onClick={() => void submitWizardOAuth()}>{oauthBusy === 'submitting' ? 'Connecting…' : 'Complete sign-in'}</button></div>{oauthError && <p className="settings-request-error" role="alert">Could not connect: {oauthError}</p>}</section></div>}</>}{error && <p className="settings-request-error" role="alert">{error}</p>}<footer><button className="secondary" type="button" onClick={() => step === 1 ? (firstRun ? void skipFirstRun() : reset()) : setStep((step - 1) as 1 | 2 | 3 | 4 | 5)} disabled={state !== 'idle'}>{step === 1 && firstRun ? 'Skip for now' : step === 1 ? 'Cancel' : 'Back'}</button><button className="primary" type="button" onClick={() => step < 5 ? setStep((step + 1) as 1 | 2 | 3 | 4 | 5) : void finish()} disabled={state !== 'idle' || (step === 3 && !agentIdFromName(name))}>{step === 1 ? 'Start fresh' : step < 5 ? 'Next' : state === 'creating' ? 'Creating…' : 'Skip / Finish'}</button></footer></div></section>}</div>}</>;
}
