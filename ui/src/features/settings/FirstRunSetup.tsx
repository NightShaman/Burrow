import { optimizeAvatar } from '../../app/avatar';
import type { AgentToolbarProps } from './AgentToolbar';
import { providerOptionLabel } from './ProviderModelFields';
import { agentIdFromName } from './setupOperation';
import { useFirstRunWorkflow } from './useFirstRunWorkflow';
import { AccessibleModal } from '../../app/AccessibleModal';
import React, { useEffect, useRef, useState } from 'react';
import type { SavedProvider } from '../../app/types';
import { api } from '../../app/api';
import type { OpenAiOAuthConnection } from './modelConnectionsApi';
import {
  savedProviderFromConnection,
  useWizardOAuthProvisioning,
} from './useWizardOAuthProvisioning';

const openAiLoginStatusLabel = (status?: string) => {
  switch (status) {
    case 'starting':
      return 'Preparing secure sign-in';
    case 'waiting_for_callback':
      return 'Finish signing in in your browser';
    case 'waiting_for_code':
      return 'Paste the sign-in callback to continue';
    case 'exchanging':
      return 'Confirming your sign-in';
    case 'authorized':
      return 'Signed in';
    case 'completed':
    case 'imported':
      return 'Connected';
    case 'cancelled':
      return 'Sign-in cancelled';
    case 'expired':
      return 'Sign-in expired';
    case 'failed':
      return 'Sign-in failed';
    default:
      return status ? status.replace(/[-_]+/g, ' ') : 'Ready to sign in';
  }
};

const claudeLoginStatusLabel = (status?: string) => {
  switch (status) {
    case 'waiting_for_code':
      return 'Waiting for callback code';
    case 'code_submitted':
      return 'Code submitted';
    case 'authorizing':
      return 'Authorizing';
    case 'authorized':
      return 'Authorized';
    case 'ready_to_import':
      return 'Ready to import';
    case 'imported':
      return 'Imported';
    case 'cancelled':
      return 'Cancelled';
    case 'expired':
      return 'Expired';
    case 'failed':
      return 'Failed';
    case 'waiting_for_url':
      return 'Starting Claude Code';
    default:
      return status ? status.replace(/[-_]+/g, ' ') : 'Idle';
  }
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="field">
      {label}
      {children}
    </label>
  );
}

/** Durable first-run owner; never mounted for ordinary registry creation. */
export function FirstRunSetup({
  onSelect,
  onAgentsChanged,
  onModelConnectionsChanged,
  onOperatorProfileChanged,
  onFirstRunComplete,
  onSetupComplete,
}: AgentToolbarProps) {
  const [showNewAgent, setShowNewAgent] = useState(false);
  const onFirstRunCompleteRef = useRef(onFirstRunComplete);
  const [step, setStep] = useState<1 | 2 | 3 | 4 | 5>(1);
  const [operatorName, setOperatorName] = useState('');
  const [operatorAvatar, setOperatorAvatar] = useState('');
  const [operatorAvatarFileName, setOperatorAvatarFileName] = useState('');
  const [name, setName] = useState('');
  const [avatar, setAvatar] = useState('');
  const [soul, setSoul] = useState('');
  const [connectionId, setConnectionId] = useState('');
  const [model, setModel] = useState('');
  const [providers, setProviders] = useState<SavedProvider[]>([]);
  const [celebrating, setCelebrating] = useState(false);
  const [error, setError] = useState('');
  const avatarInput = useRef<HTMLInputElement>(null);
  const operatorAvatarInput = useRef<HTMLInputElement>(null);
  const {
    oauthProvider,
    setOauthProvider,
    openAiLogin,
    claudeLogin,
    oauthBusy,
    oauthError,
    oauthCode,
    setOauthCode,
    startWizardOAuth,
    submitWizardOAuth,
    resetWizardOAuth,
  } = useWizardOAuthProvisioning({ setProviders, setConnectionId, setModel });
  const {
    importing,
    imported,
    importPayload,
    importPassword,
    setImportPassword,
    importInput,
    state,
    finish,
    readImportFile,
    submitProtectedImport,
    resetWorkflow,
  } = useFirstRunWorkflow({
    onSelect,
    onAgentsChanged,
    onModelConnectionsChanged,
    onOperatorProfileChanged,
    onSetupComplete,
    operatorName,
    operatorAvatar,
    name,
    avatar,
    soul,
    connectionId,
    model,
    setError,
    setCelebrating,
  });
  const reset = () => {
    resetWorkflow();
    resetWizardOAuth();
    setCelebrating(false);
    setShowNewAgent(false);
    setStep(1);
    setOperatorName('');
    setOperatorAvatar('');
    setOperatorAvatarFileName('');
    setName('');
    setAvatar('');
    setSoul('');
    setConnectionId('');
    setModel('');
    setError('');
  };
  const open = async () => {
    setShowNewAgent(true);
    setStep(1);
    setError('');
    const retained = localStorage.getItem('hc.setupOperation');
    if (retained) {
      const payload = JSON.parse(retained);
      setOperatorName(payload.operator.name);
      setOperatorAvatar(payload.operator.avatar);
      setName(payload.agent.name);
      setAvatar(payload.agentIdentity.avatar);
      setSoul(
        payload.documents.find((doc: { kind: string }) => doc.kind === 'SOUL')?.markdown ?? '',
      );
      setConnectionId(payload.modelSelection?.connectionId ?? '');
      setModel(payload.modelSelection?.model ?? '');
      setStep(5);
    }
    try {
      const result = await api<{ connections: OpenAiOAuthConnection[] }>(
        '/api/settings/model-connections',
      );
      setProviders((result.connections ?? []).map(savedProviderFromConnection));
    } catch {
      setProviders([]);
    }
  };
  useEffect(() => {
    if (!showNewAgent) void open();
  }, [showNewAgent]);
  useEffect(() => {
    onFirstRunCompleteRef.current = onFirstRunComplete;
  }, [onFirstRunComplete]);
  useEffect(() => {
    if (!celebrating) return;
    const timer = window.setTimeout(() => {
      reset();
      onFirstRunCompleteRef.current?.();
    }, 5000);
    return () => window.clearTimeout(timer);
  }, [celebrating]);
  const chooseOperatorAvatar = async (file?: File) => {
    if (!file) return;
    try {
      setOperatorAvatar(await optimizeAvatar(file));
      setOperatorAvatarFileName(file.name || 'Pasted image');
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not process the avatar image.');
    }
  };
  const chooseAvatar = async (file?: File) => {
    if (!file) return;
    try {
      setAvatar(await optimizeAvatar(file));
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not process the avatar image.');
    }
  };
  const pasteOperatorAvatar = (event: React.ClipboardEvent<HTMLDivElement>) => {
    const item = Array.from(event.clipboardData.items).find((clipboardItem) =>
      clipboardItem.type.startsWith('image/'),
    );
    const file = item?.getAsFile();
    if (!file) return;
    event.preventDefault();
    void chooseOperatorAvatar(file);
  };
  const pasteAvatar = (event: React.ClipboardEvent<HTMLDivElement>) => {
    const item = Array.from(event.clipboardData.items).find((clipboardItem) =>
      clipboardItem.type.startsWith('image/'),
    );
    const file = item?.getAsFile();
    if (!file) return;
    event.preventDefault();
    void chooseAvatar(file);
  };
  const removeOperatorAvatar = () => {
    setOperatorAvatar('');
    setOperatorAvatarFileName('');
    setError('');
    if (operatorAvatarInput.current) operatorAvatarInput.current.value = '';
  };
  const removeAvatar = () => {
    setAvatar('');
    setError('');
    if (avatarInput.current) avatarInput.current.value = '';
  };
  const provider = providers.find((item) => item.id === connectionId);
  return (
    <>
      {showNewAgent && (
        <div
          className={`agent-modal-backdrop${celebrating ? ' agent-wizard-celebrating' : ''}`}
          role="presentation"
        >
          {celebrating ? (
            <section className="agent-wizard-finale" role="status" aria-live="polite">
              <div className="wizard-confetti" aria-hidden="true">
                {Array.from({ length: 24 }, (_, index) => (
                  <i key={index} style={{ '--i': index } as React.CSSProperties} />
                ))}
              </div>
              <img src="/burrow-logo.png" alt="" />
              <span className="eyebrow">FIRST RUN COMPLETE</span>
              <h2>{imported ? 'The kingdom is restored.' : 'You magnificent thing.'}</h2>
              <p>
                {imported
                  ? 'Your export has been imported. Everything is ready for your dramatic return.'
                  : `${name || 'Your agent'} is ready for their dramatic entrance.`}
              </p>
              <span className="wizard-finale-countdown">Entering Burrow…</span>
            </section>
          ) : (
            <AccessibleModal
              className="agent-modal agent-wizard"
              role="dialog"
              aria-labelledby="new-agent-title"
              onMouseDown={(event) => event.stopPropagation()}
              onClose={() => {
                /* Mandatory onboarding stays open. */
              }}
            >
              <div className="agent-wizard-atmosphere" aria-hidden="true">
                <img src="/burrow-logo.png" alt="" />
              </div>
              <header>
                <div>
                  <span className="eyebrow">BURROW · FIRST RUN · STEP {step} OF 5</span>
                  <h2 id="new-agent-title">
                    {step === 1
                      ? 'Bring your kingdom with you'
                      : step === 2
                        ? 'Set up your operator profile'
                        : step === 3
                          ? 'Identify your first agent'
                          : step === 4
                            ? 'Give them a personality'
                            : 'Choose a model'}
                  </h2>
                  <p className="agent-wizard-lede">
                    {step === 1
                      ? 'Already have an export? Import it now and skip the setup dance.'
                      : step === 2
                        ? 'Start with you. The agents can be dramatic later.'
                        : step === 3
                          ? 'Start with a presence. You can shape the rest as you go.'
                          : step === 4
                            ? 'Make them feel like someone, not something.'
                            : 'Connect a model now, or keep moving and do it later.'}
                  </p>
                </div>
                <button
                  className="agent-modal-close"
                  type="button"
                  aria-label="Close new agent"
                  onClick={reset}
                  disabled
                >
                  ×
                </button>
              </header>
              <div className="agent-wizard-body">
                {step === 1 && (
                  <div className="wizard-import-landing">
                    <img src="/burrow-logo.png" alt="" />
                    <h3>Restore from an export</h3>
                    <p>Bring back your agents, connections, and settings in one fabulous move.</p>
                    <input
                      ref={importInput}
                      className="avatar-file-input"
                      type="file"
                      accept=".json.gz,.gz,.hc-export,.tar,.bin,application/octet-stream,application/gzip"
                      onChange={(event) => {
                        void readImportFile(event.target.files?.[0]);
                        event.currentTarget.value = '';
                      }}
                    />
                    <button
                      className="primary"
                      type="button"
                      onClick={() => importInput.current?.click()}
                      disabled={importing}
                    >
                      {importing ? 'Importing…' : 'Import export'}
                    </button>
                    {importPayload && (
                      <div className="wizard-import-password">
                        <Field label="Export password">
                          <input
                            autoFocus
                            type="password"
                            value={importPassword}
                            onChange={(event) => setImportPassword(event.target.value)}
                            placeholder="Enter the export password"
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') void submitProtectedImport();
                            }}
                          />
                        </Field>
                        <button
                          className="secondary"
                          type="button"
                          onClick={() => void submitProtectedImport()}
                          disabled={importing || !importPassword.trim()}
                        >
                          {importing ? 'Unlocking…' : 'Unlock and import'}
                        </button>
                      </div>
                    )}
                    <div className="wizard-import-divider">
                      <span>or start fresh</span>
                    </div>
                  </div>
                )}
                {step === 2 && (
                  <>
                    <div className="agent-wizard-avatar" onPaste={pasteOperatorAvatar}>
                      <div
                        className="agent-avatar-preview"
                        aria-label={`${operatorName || 'Operator'} avatar preview`}
                      >
                        {operatorAvatar ? (
                          <img src={operatorAvatar} alt="" />
                        ) : (
                          (operatorName.trim()[0] || '?').toUpperCase()
                        )}
                      </div>
                      <div className="operator-profile-details">
                        <div className="avatar-file-control">
                          <label className="avatar-file-name">
                            Operator image
                            <input
                              value={operatorAvatarFileName}
                              placeholder="Paste an image or choose a file"
                              readOnly
                              aria-label="Operator avatar image"
                            />
                          </label>
                          <button
                            className="secondary"
                            type="button"
                            onClick={() => operatorAvatarInput.current?.click()}
                          >
                            Choose image
                          </button>
                          <input
                            ref={operatorAvatarInput}
                            className="avatar-file-input"
                            type="file"
                            accept="image/*"
                            onChange={(event) => {
                              void chooseOperatorAvatar(event.target.files?.[0]);
                              event.currentTarget.value = '';
                            }}
                          />
                        </div>
                        {operatorAvatar && (
                          <button
                            className="avatar-remove"
                            type="button"
                            onClick={removeOperatorAvatar}
                          >
                            Remove image
                          </button>
                        )}
                      </div>
                    </div>
                    <Field label="Displayed name">
                      <input
                        autoFocus
                        value={operatorName}
                        onChange={(event) => setOperatorName(event.target.value)}
                        placeholder="Your name"
                        maxLength={64}
                      />
                    </Field>
                  </>
                )}
                {step === 3 && (
                  <>
                    <div className="wizard-agent-fields">
                      <Field label="Name">
                        <input
                          autoFocus
                          value={name}
                          onChange={(event) => setName(event.target.value)}
                          placeholder="Luna"
                          maxLength={64}
                        />
                      </Field>
                    </div>
                    <div className="agent-wizard-avatar" onPaste={pasteAvatar}>
                      <div
                        className="agent-avatar-preview"
                        aria-label={`${name || 'New agent'} avatar preview`}
                      >
                        {avatar ? (
                          <img src={avatar} alt="" />
                        ) : (
                          (name.trim()[0] || '?').toUpperCase()
                        )}
                      </div>
                      <div className="operator-profile-details">
                        <div className="avatar-file-control">
                          <label className="avatar-file-name">
                            Avatar image
                            <input
                              value={avatar ? 'Image attached' : ''}
                              placeholder="Paste an image or choose a file"
                              readOnly
                              aria-label="Avatar image"
                            />
                          </label>
                          <button
                            className="secondary"
                            type="button"
                            onClick={() => avatarInput.current?.click()}
                          >
                            Choose image
                          </button>
                          <input
                            ref={avatarInput}
                            className="avatar-file-input"
                            type="file"
                            accept="image/*"
                            onChange={(event) => {
                              void chooseAvatar(event.target.files?.[0]);
                              event.currentTarget.value = '';
                            }}
                          />
                        </div>
                        {avatar && (
                          <button className="avatar-remove" type="button" onClick={removeAvatar}>
                            Remove image
                          </button>
                        )}
                      </div>
                    </div>
                  </>
                )}
                {step === 4 && (
                  <Field label="SOUL.md">
                    <textarea
                      autoFocus
                      value={soul}
                      onChange={(event) => setSoul(event.target.value)}
                      rows={8}
                      placeholder="Who is this agent?"
                    />
                  </Field>
                )}
                {step === 5 && (
                  <>
                    <p className="settings-description">
                      Connect a chat model now, or finish and configure it later. This is not
                      required.
                    </p>
                    <div className="oauth-shortcuts wizard-oauth-shortcuts">
                      <button
                        className="oauth-trigger"
                        type="button"
                        onClick={() => void startWizardOAuth('openai')}
                      >
                        <span>OpenAI</span>
                        <small>Sign in with ChatGPT</small>
                      </button>
                      <button
                        className="oauth-trigger"
                        type="button"
                        onClick={() => void startWizardOAuth('anthropic')}
                      >
                        <span>Anthropic</span>
                        <small>Claude Code login</small>
                      </button>
                    </div>
                    {providers.length > 0 && (
                      <div className="field-pair provider-model-fields">
                        <Field label="Provider">
                          <select
                            value={connectionId}
                            onChange={(event) => {
                              setConnectionId(event.target.value);
                              setModel('');
                            }}
                          >
                            <option value="">Skip for now</option>
                            {providers.map((item) => (
                              <option key={item.id} value={item.id}>
                                {providerOptionLabel(providers, item)}
                              </option>
                            ))}
                          </select>
                        </Field>
                        {provider && (
                          <Field label="Model">
                            <select
                              value={model}
                              onChange={(event) => setModel(event.target.value)}
                            >
                              <option value="">Select a model</option>
                              {provider.models.map((item) => (
                                <option key={item} value={item}>
                                  {item}
                                </option>
                              ))}
                            </select>
                          </Field>
                        )}
                      </div>
                    )}
                    {oauthProvider && (
                      <div className="oauth-modal-backdrop" role="presentation">
                        <AccessibleModal
                          className="oauth-modal"
                          role="dialog"
                          aria-labelledby="wizard-oauth-title"
                          onClose={() => {
                            if (oauthBusy === 'idle') setOauthProvider(null);
                          }}
                        >
                          <div className="oauth-modal-header">
                            <div>
                              <span className="eyebrow">CONNECT A MODEL</span>
                              <h2 id="wizard-oauth-title">
                                {oauthProvider === 'openai' ? 'OpenAI OAuth' : 'Anthropic OAuth'}
                              </h2>
                            </div>
                            <button
                              className="modal-close"
                              type="button"
                              aria-label="Close OAuth dialog"
                              onClick={() => oauthBusy === 'idle' && setOauthProvider(null)}
                            >
                              ×
                            </button>
                          </div>
                          {oauthProvider === 'openai' ? (
                            <>
                              <p className="oauth-helper">
                                Sign in with ChatGPT, then paste the callback URL or code below.
                                We’ll save the connection with every available model selected.
                              </p>
                              {openAiLogin?.authorizationUrl && (
                                <a
                                  className="primary oauth-login-link"
                                  href={openAiLogin.authorizationUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  Open ChatGPT sign-in
                                </a>
                              )}
                            </>
                          ) : (
                            <>
                              <p className="oauth-helper">
                                Complete the Claude Code login, then paste its callback code.
                                Available models will be selected and saved automatically.
                              </p>
                              {claudeLogin?.verificationUrl && (
                                <a
                                  className="primary oauth-login-link"
                                  href={claudeLogin.verificationUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  Open Claude sign-in
                                </a>
                              )}
                            </>
                          )}
                          <p className="oauth-status" role="status">
                            {oauthProvider === 'openai'
                              ? openAiLoginStatusLabel(
                                  openAiLogin?.status ??
                                    (oauthBusy === 'starting' ? 'starting' : undefined),
                                )
                              : claudeLoginStatusLabel(
                                  claudeLogin?.status ??
                                    (oauthBusy === 'starting' ? 'waiting_for_url' : undefined),
                                )}
                          </p>
                          <Field
                            label={
                              oauthProvider === 'openai' ? 'Callback URL or code' : 'Callback code'
                            }
                          >
                            <input
                              autoFocus
                              value={oauthCode}
                              onChange={(event) => setOauthCode(event.target.value)}
                            />
                          </Field>
                          <div className="claude-login-actions">
                            <button
                              className="primary"
                              type="button"
                              disabled={!oauthCode.trim() || oauthBusy !== 'idle'}
                              onClick={() => void submitWizardOAuth()}
                            >
                              {oauthBusy === 'submitting' ? 'Connecting…' : 'Complete sign-in'}
                            </button>
                          </div>
                          {oauthError && (
                            <p className="settings-request-error" role="alert">
                              Could not connect: {oauthError}
                            </p>
                          )}
                        </AccessibleModal>
                      </div>
                    )}
                  </>
                )}
                {error && (
                  <p className="settings-request-error" role="alert">
                    {error}
                  </p>
                )}
                <footer>
                  {step > 1 && (
                    <button
                      className="secondary"
                      type="button"
                      onClick={() => setStep((step - 1) as 1 | 2 | 3 | 4 | 5)}
                      disabled={state !== 'idle'}
                    >
                      Back
                    </button>
                  )}
                  <button
                    className="primary"
                    type="button"
                    onClick={() =>
                      step < 5 ? setStep((step + 1) as 1 | 2 | 3 | 4 | 5) : void finish()
                    }
                    disabled={state !== 'idle' || (step === 3 && !agentIdFromName(name))}
                  >
                    {step === 1
                      ? 'Start fresh'
                      : step < 5
                        ? 'Next'
                        : state === 'creating'
                          ? 'Creating…'
                          : 'Skip / Finish'}
                  </button>
                </footer>
              </div>
            </AccessibleModal>
          )}
        </div>
      )}
    </>
  );
}
