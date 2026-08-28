import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { SavedProvider } from '../../app/types';
import { ModelConnectionOAuthDialog } from './ModelConnectionOAuthDialog';
import { ModelResults, SavedProviders, modelConnectionApiTypes } from './ModelConnectionViews';
import { Field, SettingSection } from './SettingsPrimitives';
import { useModelConnectionEditor } from './useModelConnectionEditor';

type Props = {
  savedProviders: SavedProvider[];
  onModelConnectionsChanged: () => Promise<void>;
  mcpConnections: ReactNode;
  overflowTarget?: HTMLElement | null;
};

export function ModelConnections({ savedProviders, onModelConnectionsChanged, mcpConnections, overflowTarget }: Props) {
  const editor = useModelConnectionEditor({ onModelConnectionsChanged });

  return <div className="connections-stack">
    <div className="connections-models-column">
      <SettingSection title="Models">
        <div className="field-pair">
          <Field label="Provider"><input value={editor.provider} onChange={(event) => editor.setProvider(event.target.value)} placeholder="OpenAI" /></Field>
          <Field label="API type"><select value={editor.apiType} onChange={(event) => editor.setApiType(event.target.value)}>{modelConnectionApiTypes.map((type) => <option value={type.value} key={type.value}>{type.label}</option>)}</select></Field>
        </div>
        <p className="settings-description">{editor.apiType === 'anthropic-messages'
          ? 'Anthropic Messages uses Anthropic’s native API contract and provider authentication. Model discovery is handled by Burrow, not an OpenAI-compatible /models probe.'
          : 'OpenAI-compatible connections discover models through the provider’s /models endpoint.'}</p>
        <div className="oauth-shortcuts">
          <button className={`oauth-trigger${editor.apiType !== 'anthropic-messages' ? ' active' : ''}`} type="button" onClick={editor.openOpenAiOAuth}><span>OpenAI OAuth</span><small>Sign in with ChatGPT</small></button>
          <button className={`oauth-trigger${editor.apiType === 'anthropic-messages' ? ' active' : ''}`} type="button" onClick={editor.openAnthropicOAuth}><span>Anthropic OAuth</span><small>Claude Code login</small></button>
        </div>
        {editor.oauthModal && <ModelConnectionOAuthDialog
          kind={editor.oauthModal}
          editingId={editor.editingId}
          apiType={editor.apiType}
          onClose={() => editor.setOauthModal(null)}
          openAi={editor.openAiFlow}
          claude={editor.claudeFlow}
        />}
        <div className="field-pair">
          <Field label="URL"><input value={editor.url} onChange={(event) => editor.setUrl(event.target.value)} placeholder={editor.apiType === 'anthropic-messages' ? 'https://api.anthropic.com' : 'https://api.example.com/v1'} /></Field>
          <Field label="API key"><input type="password" value={editor.apiKey} onChange={(event) => editor.setApiKey(event.target.value)} placeholder={editor.apiKeyConfigured ? '•••••••• (configured — enter a new key to replace it)' : 'Enter API key'} /></Field>
        </div>
        <div className="model-actions">
          {editor.editingId && <button className="secondary" onClick={editor.resetProvider}>Cancel</button>}
          <button className="secondary" onClick={() => void editor.connect()} disabled={!editor.provider.trim() || !editor.url.trim() || editor.requestState !== 'idle'}>{editor.requestState === 'connecting' ? 'Connecting…' : 'Connect'}</button>
          <button className="primary" onClick={() => void editor.saveProvider()} disabled={!editor.provider.trim() || !editor.url.trim() || !editor.availableModels.some((model) => model.selected !== false) || editor.requestState !== 'idle'}>{editor.requestState === 'saving' ? 'Saving…' : 'Save'}</button>
        </div>
        {editor.requestError && <p className="settings-request-error" role="alert">{editor.requestError}</p>}
        {(editor.connected || Boolean(editor.requestError)) && <ModelResults
          models={editor.availableModels}
          manualModel={editor.manualModel}
          onManualModelChange={editor.setManualModel}
          onAddManualModel={editor.addManualModel}
          onDeleteManualModel={editor.deleteManualModel}
          onToggleModel={editor.toggleModel}
          onToggleModelInput={editor.toggleModelInput}
          onSetModelInputAuto={editor.setModelInputAuto}
        />}
        {!overflowTarget && <SavedProviders
          providers={savedProviders}
          open={editor.savedProvidersOpen}
          onOpenChange={editor.setSavedProvidersOpen}
          onEdit={editor.editProvider}
          onDelete={(item) => void editor.deleteProvider(item)}
        />}
      </SettingSection>
    </div>
    {mcpConnections}
    {overflowTarget && createPortal(<SavedProviders providers={savedProviders} open={editor.savedProvidersOpen} onOpenChange={editor.setSavedProvidersOpen} onEdit={editor.editProvider} onDelete={(item) => void editor.deleteProvider(item)} expanded />, overflowTarget)}
  </div>;
}
