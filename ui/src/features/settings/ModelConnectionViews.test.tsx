import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelResults, SavedProviders } from './ModelConnectionViews';
import { claudeLoginStatusLabel, openAiLoginStatusLabel } from './ModelConnectionOAuthDialog';

afterEach(cleanup);

describe('Model connection views', () => {
  it('renders model capabilities and delegates editor actions', () => {
    const onToggleModel = vi.fn();
    const onToggleModelInput = vi.fn();
    const onSetModelInputAuto = vi.fn();
    const onDeleteManualModel = vi.fn();
    const onAddManualModel = vi.fn();
    render(<ModelResults
      models={[{ id: 'vision-model', displayName: 'Vision Model', selected: true, manual: true, acceptedInput: ['text'], acceptedInputOverride: ['text'], acceptedOutputOverride: ['text'], acceptedOutput: ['text'] }]}
      manualModel="new-model"
      onManualModelChange={vi.fn()}
      onAddManualModel={onAddManualModel}
      onDeleteManualModel={onDeleteManualModel}
      onToggleModel={onToggleModel}
      onToggleModelInput={onToggleModelInput}
      onSetModelInputAuto={onSetModelInputAuto}
      onToggleModelOutput={vi.fn()}
      onSetModelOutputAuto={vi.fn()}
    />);

    fireEvent.click(screen.getByLabelText('Vision Model'));
    fireEvent.click(screen.getByLabelText('Auto'));
    fireEvent.click(screen.getByLabelText('Image'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete manually added model vision-model' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add model' }));

    expect(onToggleModel).toHaveBeenCalledWith('vision-model');
    expect(onSetModelInputAuto).toHaveBeenCalledWith('vision-model', true);
    expect(onToggleModelInput).toHaveBeenCalledWith('vision-model', 'image');
    expect(onDeleteManualModel).toHaveBeenCalledWith('vision-model');
    expect(onAddManualModel).toHaveBeenCalledOnce();
  });

  it('renders saved authentication details and delegates provider actions', () => {
    const provider = { id: 'openai', provider: 'OpenAI', apiType: 'openai-responses', url: 'https://example.test', apiKey: '', models: ['gpt-test'], oauthConfigured: true, authSource: 'browser' };
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    render(<SavedProviders providers={[provider]} open onOpenChange={vi.fn()} onEdit={onEdit} onDelete={onDelete} />);

    expect(screen.getByText('OAuth configured')).toBeTruthy();
    expect(screen.queryByText('Source: browser')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /OpenAI.*OpenAI Responses.*1 model/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete OpenAI' }));
    expect(onEdit).toHaveBeenCalledWith(provider);
    expect(onDelete).toHaveBeenCalledWith(provider);
  });

  it('selects an expanded provider without a separate Edit action or verbose model list', () => {
    const provider = { id: 'openai', provider: 'OpenAI', apiType: 'openai-responses', url: 'https://example.test', apiKey: '', models: ['gpt-test'] };
    const onEdit = vi.fn();
    render(<SavedProviders providers={[provider]} open onOpenChange={vi.fn()} onEdit={onEdit} onDelete={vi.fn()} selectedId="openai" expanded />);
    const selector = screen.getByRole('button', { name: /OpenAI.*OpenAI Responses.*1 model/ });
    expect(selector.getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByText('gpt-test')).toBeNull();
    fireEvent.click(selector);
    expect(onEdit).toHaveBeenCalledWith(provider);
  });

  it('normalizes known and unknown OAuth statuses for display', () => {
    expect(openAiLoginStatusLabel('waiting_for_callback')).toBe('Finish signing in in your browser');
    expect(openAiLoginStatusLabel('future_status')).toBe('future status');
    expect(claudeLoginStatusLabel('ready_to_import')).toBe('Ready to import');
    expect(claudeLoginStatusLabel()).toBe('Idle');
  });
});
