import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { RuntimeModel } from '../../app/api';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelCapabilityEditor, ModelResults, SavedProviders } from './ModelConnectionViews';
import { claudeLoginStatusLabel, openAiLoginStatusLabel } from './ModelConnectionOAuthDialog';

afterEach(cleanup);

describe('Model connection views', () => {
  it('keeps model cards compact and delegates selection actions', () => {
    const onToggleModel = vi.fn();
    const onSelectModel = vi.fn();
    const onDeleteManualModel = vi.fn();
    const onAddManualModel = vi.fn();
    render(<ModelResults
      models={[{ id: 'vision-model', displayName: 'Vision Model', selected: true, manual: true, discoveredInput: ['text', 'image'], discoveredOutput: ['text'] }]}
      manualModel="new-model"
      onManualModelChange={vi.fn()}
      onAddManualModel={onAddManualModel}
      onDeleteManualModel={onDeleteManualModel}
      onToggleModel={onToggleModel}
      onSelectModel={onSelectModel}
    />);

    fireEvent.click(screen.getByRole('button', { name: /Vision Model/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Use Vision Model' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete manually added model vision-model' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add model' }));

    expect(onSelectModel).toHaveBeenCalledWith('vision-model');
    expect(onToggleModel).toHaveBeenCalledWith('vision-model');
    expect(onDeleteManualModel).toHaveBeenCalledWith('vision-model');
    expect(onAddManualModel).toHaveBeenCalledOnce();
  });

  it('shows discovered capabilities and unknown fallback in the detail editor', () => {
    const model: RuntimeModel = { id: 'vision-model', displayName: 'Vision Model', discoveredInput: ['text', 'image'], acceptedInput: ['text', 'image'], acceptedOutput: ['text'], capabilityProvenance: { source: 'models.dev', snapshotAt: '2026-09-26T12:00:00.000Z', matchedProvider: 'OpenAI', matchedModel: 'gpt-4o' } };
    render(<ModelCapabilityEditor model={model} onToggleModelInput={vi.fn()} onSetModelInputAuto={vi.fn()} onToggleModelOutput={vi.fn()} onSetModelOutputAuto={vi.fn()} />);
    expect(screen.getByText('Discovered: text, image')).toBeTruthy();
    expect(screen.getByText('Unknown')).toBeTruthy();
    expect(screen.getByText('Source: models.dev · match OpenAI / gpt-4o · snapshot 9/26/2026')).toBeTruthy();
  });

  it('keeps manual output capability checkboxes interactive and delegates toggles', () => {
    const onToggleModelOutput = vi.fn();
    const model: RuntimeModel = {
      id: 'text-model',
      acceptedOutput: ['text'],
      acceptedOutputOverride: ['text'],
    };
    render(<ModelCapabilityEditor model={model} onToggleModelInput={vi.fn()} onSetModelInputAuto={vi.fn()} onToggleModelOutput={onToggleModelOutput} onSetModelOutputAuto={vi.fn()} />);

    const audio = screen.getByRole('checkbox', { name: 'Output audio' });
    expect(audio.hasAttribute('disabled')).toBe(false);
    expect(screen.getByRole('checkbox', { name: 'Output text' }).hasAttribute('checked')).toBe(true);
    fireEvent.click(audio);
    expect(onToggleModelOutput).toHaveBeenCalledWith('text-model', 'audio');
  });

  it('renders output manual changes when the editor state updates', () => {
    function Harness() {
      const [model, setModel] = React.useState<RuntimeModel>({ id: 'text-model', acceptedOutput: ['text'], acceptedOutputOverride: ['text'] });
      return <ModelCapabilityEditor
        model={model}
        onToggleModelInput={vi.fn()}
        onSetModelInputAuto={vi.fn()}
        onToggleModelOutput={(_, output) => setModel((current) => {
          const acceptedOutput = current.acceptedOutput ?? [];
          const next = acceptedOutput.includes(output) ? acceptedOutput.filter((value) => value !== output) : [...acceptedOutput, output];
          return { ...current, acceptedOutput: next, acceptedOutputOverride: next };
        })}
        onSetModelOutputAuto={vi.fn()}
      />;
    }
    render(<Harness />);
    const audio = screen.getByRole('checkbox', { name: 'Output audio' }) as HTMLInputElement;
    const text = screen.getByRole('checkbox', { name: 'Output text' }) as HTMLInputElement;
    expect(text.checked).toBe(true);
    fireEvent.click(audio);
    expect(audio.checked).toBe(true);
    fireEvent.click(text);
    expect(text.checked).toBe(false);
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
