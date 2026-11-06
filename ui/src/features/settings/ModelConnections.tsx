import { useEffect, useState, type ReactNode } from 'react';
import './modelsWorkspace.css';
import { createPortal } from 'react-dom';
import type { SavedProvider } from '../../app/types';
import { ModelConnectionOAuthDialog } from './ModelConnectionOAuthDialog';
import {
  ModelCapabilityEditor,
  ModelResults,
  SavedProviders,
  modelConnectionApiTypes,
} from './ModelConnectionViews';
import { Field, SettingSection } from './SettingsPrimitives';
import { isProviderPool } from './providerPools';
import { useModelConnectionEditor } from './useModelConnectionEditor';

type Props = {
  savedProviders: SavedProvider[];
  loadBalancing?: boolean;
  onModelConnectionsChanged: () => Promise<void>;
  mcpConnections: ReactNode;
  overflowTarget?: HTMLElement | null;
};

export function ModelConnections({
  savedProviders,
  onModelConnectionsChanged,
  mcpConnections,
  overflowTarget,
  loadBalancing = false,
}: Props) {
  const editor = useModelConnectionEditor({
    savedProviders,
    onModelConnectionsChanged,
    loadBalancing,
  });
  const [connectionExpanded, setConnectionExpanded] = useState(false);
  useEffect(() => {
    setConnectionExpanded(false);
  }, [editor.editingId]);
  const showConnectionFields =
    !editor.editingId || connectionExpanded || editor.connectionRecoveryRequired;
  const visibleProviders = savedProviders.filter(
    (item) => isProviderPool(item.apiType) === loadBalancing,
  );
  const apiTypes = modelConnectionApiTypes.filter(
    (type) => isProviderPool(type.value) === loadBalancing,
  );
  const selectedModel =
    editor.availableModels.find((model) => model.id === editor.selectedModelId) ?? null;

  const modelDetail = selectedModel ? (
    <ModelCapabilityEditor
      model={selectedModel}
      onToggleModelInput={editor.toggleModelInput}
      onSetModelInputAuto={editor.setModelInputAuto}
      onToggleModelOutput={editor.toggleModelOutput}
      onSetModelOutputAuto={editor.setModelOutputAuto}
      onSetModelContextAuto={editor.setModelContextAuto}
      onSetModelContextOverride={editor.setModelContextOverride}
    />
  ) : (
    <div className="model-detail-empty">
      <strong>Select a model to edit capabilities</strong>
    </div>
  );

  if (loadBalancing)
    return (
      <LoadBalancingPools
        editor={editor}
        providers={visibleProviders}
        overflowTarget={overflowTarget}
      />
    );

  return (
    <div className="models-workspace">
      <aside className="models-provider-column" aria-label="Model connections">
        <header className="models-workspace-header">
          <h2>Models</h2>
          <button type="button" className="secondary" onClick={editor.resetProvider}>
            Add provider
          </button>
        </header>
        <section className="models-provider-inventory" aria-label="Saved providers">
          <h3>Saved providers</h3>
          <SavedProviders
            providers={visibleProviders}
            open
            onOpenChange={editor.setSavedProvidersOpen}
            onEdit={editor.editProvider}
            selectedId={editor.editingId}
            onDelete={(item) => void editor.deleteProvider(item)}
            expanded
          />
        </section>
      </aside>
      <div className="models-editor-column">
        <section className="models-connection-editor" aria-label="Provider connection">
          <div className="models-connection-heading">
            <h3>{editor.editingId ? editor.provider : 'New provider'}</h3>
            {editor.editingId && (
              <button
                type="button"
                className="secondary"
                aria-expanded={showConnectionFields}
                aria-controls="models-connection-fields"
                disabled={editor.connectionRecoveryRequired}
                title={
                  editor.connectionRecoveryRequired
                    ? 'Connection recovery stays open until Connect succeeds or you switch providers.'
                    : undefined
                }
                onClick={() => setConnectionExpanded((value) => !value)}
              >
                {showConnectionFields ? 'Hide connection' : 'Edit connection'}
              </button>
            )}
          </div>
          <div
            id="models-connection-fields"
            className="models-connection-fields"
            hidden={!showConnectionFields}
          >
            <div className="field-pair">
              <Field label="Provider">
                <input
                  value={editor.provider}
                  onChange={(event) => editor.setProvider(event.target.value)}
                  placeholder="OpenAI"
                />
              </Field>
              <Field label={loadBalancing ? 'Pool type' : 'API type'}>
                <select
                  value={editor.apiType}
                  disabled={editor.requestState === 'saving'}
                  onChange={(event) => editor.setApiType(event.target.value)}
                >
                  {apiTypes.map((type) => (
                    <option value={type.value} key={type.value}>
                      {type.label}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            {!editor.poolConnection && (
              <div className="field-pair">
                <Field label="URL">
                  <input
                    value={editor.url}
                    onChange={(event) => editor.setUrl(event.target.value)}
                    placeholder={
                      editor.apiType === 'anthropic-messages'
                        ? 'https://api.anthropic.com'
                        : editor.apiType === 'google-generative-language'
                          ? 'https://generativelanguage.googleapis.com/v1beta'
                          : 'https://api.example.com/v1'
                    }
                  />
                </Field>
                <Field label="API key">
                  <input
                    type="password"
                    value={editor.apiKey}
                    onChange={(event) => editor.setApiKey(event.target.value)}
                    placeholder={
                      editor.apiKeyConfigured
                        ? '•••••••• (configured — enter a new key to replace it)'
                        : 'Enter API key'
                    }
                  />
                </Field>
              </div>
            )}
            {!editor.poolConnection && (
              <div className="oauth-shortcuts">
                <button
                  className={`oauth-trigger${editor.apiType !== 'anthropic-messages' ? ' active' : ''}`}
                  type="button"
                  onClick={editor.openOpenAiOAuth}
                >
                  <span>OpenAI OAuth</span>
                  <small>Sign in with ChatGPT</small>
                </button>
                <button
                  className={`oauth-trigger${editor.apiType === 'anthropic-messages' ? ' active' : ''}`}
                  type="button"
                  onClick={editor.openAnthropicOAuth}
                >
                  <span>Anthropic OAuth</span>
                  <small>Claude Code login</small>
                </button>
              </div>
            )}
            {editor.editingId &&
              editor.oauthConnection &&
              editor.apiType === 'openai-responses' && (
                <div className="field-pair oauth-token-fields">
                  <Field label="OpenAI ID token">
                    <input
                      type="password"
                      autoComplete="off"
                      value={editor.oauthIdToken}
                      onChange={(event) => editor.setOauthIdToken(event.target.value)}
                      placeholder="Leave blank to keep current token"
                    />
                  </Field>
                  <Field label="OpenAI access token">
                    <input
                      type="password"
                      autoComplete="off"
                      value={editor.oauthAccessToken}
                      onChange={(event) => editor.setOauthAccessToken(event.target.value)}
                      placeholder="Leave blank to keep current token"
                    />
                  </Field>
                  <Field label="OpenAI refresh token">
                    <input
                      type="password"
                      autoComplete="off"
                      value={editor.oauthRefreshToken}
                      onChange={(event) => editor.setOauthRefreshToken(event.target.value)}
                      placeholder="Leave blank to keep current token"
                    />
                  </Field>
                </div>
              )}
            {editor.canAutoUseExpiringResets && (
              <div className="models-connection-options">
                <label className="settings-checkbox-row">
                  <input
                    type="checkbox"
                    checked={editor.autoUseExpiringResets}
                    disabled={editor.requestState !== 'idle'}
                    aria-describedby="auto-use-expiring-resets-help"
                    onChange={(event) => editor.setAutoUseExpiringResets(event.target.checked)}
                  />
                  Automatically use expiring resets
                </label>
                <p id="auto-use-expiring-resets-help" className="settings-help">
                  Uses banked reset credits within 5 minutes of expiry. Runs in the backend even
                  when your browser is closed. Manual resets stay available.
                </p>
              </div>
            )}
          </div>
          <div className="model-actions">
            {(editor.editingId || editor.poolConnection) && (
              <button className="secondary" onClick={editor.resetProvider}>
                Cancel
              </button>
            )}
            <button
              className="secondary"
              onClick={() => void editor.connect()}
              disabled={!editor.connectionReady || editor.requestState !== 'idle'}
            >
              {editor.requestState === 'connecting' ? 'Connecting…' : 'Connect'}
            </button>
            <button
              className="primary"
              onClick={() => void editor.saveProvider()}
              disabled={
                !editor.connectionReady ||
                !editor.availableModels.some((model) => model.selected !== false) ||
                editor.requestState !== 'idle'
              }
            >
              {editor.requestState === 'saving' ? 'Saving…' : 'Save'}
            </button>
          </div>
          {editor.requestError && (
            <p className="settings-request-error" role="alert">
              {editor.requestError}
            </p>
          )}
        </section>
        {(editor.connected || Boolean(editor.requestError)) && (
          <section className="models-catalog-workspace" aria-label="Provider models">
            <div className="models-catalog-picker">
              <h3>
                Models <span className="models-count">{editor.availableModels.length}</span>
              </h3>
              <ModelResults
                compact
                models={editor.availableModels}
                manualModel={editor.manualModel}
                onManualModelChange={editor.setManualModel}
                onAddManualModel={editor.addManualModel}
                onDeleteManualModel={editor.deleteManualModel}
                selectedModelId={editor.selectedModelId}
                onSelectModel={editor.setSelectedModelId}
                onToggleModel={editor.toggleModel}
              />
            </div>
            <section className="models-capabilities-workspace" aria-label="Model details">
              {modelDetail}
            </section>
          </section>
        )}
        {editor.oauthModal && (
          <ModelConnectionOAuthDialog
            kind={editor.oauthModal}
            editingId={editor.editingId}
            apiType={editor.apiType}
            onClose={() => editor.setOauthModal(null)}
            openAi={editor.openAiFlow}
            claude={editor.claudeFlow}
          />
        )}
        {mcpConnections}
      </div>
    </div>
  );
}

function LoadBalancingPools({
  editor,
  providers,
  overflowTarget,
}: {
  editor: ReturnType<typeof useModelConnectionEditor>;
  providers: SavedProvider[];
  overflowTarget?: HTMLElement | null;
}) {
  const saved = (
    <SavedProviders
      pools
      providers={providers}
      open={editor.savedProvidersOpen}
      onOpenChange={editor.setSavedProvidersOpen}
      onEdit={editor.editProvider}
      selectedId={editor.editingId}
      onDelete={(item) => void editor.deleteProvider(item)}
      expanded={Boolean(overflowTarget)}
    />
  );
  return (
    <div className="connections-stack">
      <div className="connections-models-column">
        <SettingSection title="Load Balancing">
          <div className="field-pair">
            <Field label="Name">
              <input
                value={editor.provider}
                onChange={(event) => editor.setProvider(event.target.value)}
                placeholder="Pool name"
              />
            </Field>
            <Field label="Adapter">
              <select
                value={editor.apiType}
                disabled={editor.requestState === 'saving'}
                onChange={(event) => editor.setApiType(event.target.value)}
              >
                <option value="openai-lb">OpenAI</option>
                <option value="anthropic-lb">Anthropic</option>
              </select>
            </Field>
          </div>
          <label className="pool-account">
            <input
              type="checkbox"
              checked={editor.poolEnabled}
              onChange={(event) => editor.setPoolEnabled(event.target.checked)}
            />
            <span>Enabled</span>
          </label>
          <fieldset className="provider-pool">
            <legend>Member accounts</legend>
            <div className="pool-accounts">
              {editor.poolMembers.map((member) => (
                <label className="pool-account" key={member.id}>
                  <input
                    type="checkbox"
                    checked={editor.memberConnectionIds.includes(member.id)}
                    onChange={() => editor.togglePoolMember(member.id)}
                  />
                  <span>{member.provider}</span>
                </label>
              ))}
            </div>
            {!editor.poolMembers.length && (
              <p className="settings-empty">
                Connect a compatible {editor.apiType === 'openai-lb' ? 'OpenAI' : 'Anthropic'} OAuth
                account in Models first.
              </p>
            )}
            {editor.missingPoolMembers.map((id) => (
              <label className="pool-account" key={id}>
                <input type="checkbox" checked onChange={() => editor.togglePoolMember(id)} />
                <span>Unavailable account: {id}</span>
              </label>
            ))}
            {!!editor.missingPoolMembers.length && (
              <p className="settings-request-error" role="alert">
                Remove unavailable accounts before saving.
              </p>
            )}
          </fieldset>
          <div className="model-actions">
            <button className="secondary" onClick={editor.resetProvider}>
              Cancel
            </button>
            <button
              className="primary"
              onClick={() => void editor.saveProvider()}
              disabled={!editor.connectionReady || editor.requestState !== 'idle'}
            >
              {editor.requestState === 'saving' ? 'Saving…' : 'Save'}
            </button>
          </div>
          {editor.requestError && (
            <p className="settings-request-error" role="alert">
              {editor.requestError}
            </p>
          )}
          {!overflowTarget && saved}
        </SettingSection>
      </div>
      {overflowTarget &&
        createPortal(
          <div className="settings-overflow-content">
            <SettingSection title="Saved pools">{saved}</SettingSection>
          </div>,
          overflowTarget,
        )}
    </div>
  );
}
