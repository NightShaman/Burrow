import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { RuntimeModel } from '../../app/api';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ModelCapabilityEditor,
  ModelResults,
  SavedProviders,
  modelConnectionApiTypes,
} from './ModelConnectionViews';
import { claudeLoginStatusLabel, openAiLoginStatusLabel } from './ModelConnectionOAuthDialog';

afterEach(cleanup);

describe('Model connection views', () => {
  it('keeps model cards compact and delegates selection actions', () => {
    const onToggleModel = vi.fn();
    const onSelectModel = vi.fn();
    const onDeleteManualModel = vi.fn();
    const onAddManualModel = vi.fn();
    render(
      <ModelResults
        models={[
          {
            id: 'vision-model',
            displayName: 'Vision Model',
            selected: true,
            manual: true,
            discoveredInput: ['text', 'image'],
            discoveredOutput: ['text'],
          },
        ]}
        manualModel="new-model"
        onManualModelChange={vi.fn()}
        onAddManualModel={onAddManualModel}
        onDeleteManualModel={onDeleteManualModel}
        onToggleModel={onToggleModel}
        onSelectModel={onSelectModel}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Vision Model/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Use Vision Model' }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Delete manually added model vision-model' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add model' }));

    expect(onSelectModel).toHaveBeenCalledWith('vision-model');
    expect(onToggleModel).toHaveBeenCalledWith('vision-model');
    expect(onDeleteManualModel).toHaveBeenCalledWith('vision-model');
    expect(onAddManualModel).toHaveBeenCalledOnce();
  });

  it('shows discovered capabilities and unknown fallback in the detail editor', () => {
    const model: RuntimeModel = {
      id: 'vision-model',
      displayName: 'Vision Model',
      discoveredInput: ['text', 'image'],
      acceptedInput: ['text', 'image'],
      acceptedOutput: ['text'],
      capabilityProvenance: {
        source: 'models.dev',
        snapshotAt: '2026-09-26T12:00:00.000Z',
        matchedProvider: 'OpenAI',
        matchedModel: 'gpt-4o',
      },
    };
    render(
      <ModelCapabilityEditor
        model={model}
        onToggleModelInput={vi.fn()}
        onSetModelInputAuto={vi.fn()}
        onToggleModelOutput={vi.fn()}
        onSetModelOutputAuto={vi.fn()}
      />,
    );
    expect(screen.getByText('Discovered: text, image')).toBeTruthy();
    for (const name of ['Context window', 'Input', 'Output']) {
      const group = screen.getByRole('group', { name });
      expect(group.tagName).toBe('FIELDSET');
      expect(group.querySelector('legend')).toBeNull();
      const title = group.querySelector('.model-capability-title');
      expect(title?.textContent).toBe(name);
      expect(group.getAttribute('aria-labelledby')).toBe(title?.id);
    }
    expect(
      screen
        .getByLabelText('Output token limit')
        .closest('.model-output-limit')
        ?.querySelector('.model-capability-title')?.textContent,
    ).toBe('Output token limit');
    const gif = screen.getByRole('checkbox', { name: 'Output gif' }) as HTMLInputElement;
    expect(gif.disabled).toBe(true);
    expect(gif.checked).toBe(false);
    expect(screen.getAllByText('Unknown').length).toBeGreaterThan(0);
    expect(
      screen.getByText('Source: models.dev · match OpenAI / gpt-4o · snapshot 9/26/2026'),
    ).toBeTruthy();
  });

  it('supports discovered context windows and positive manual overrides', () => {
    const onAuto = vi.fn();
    const onOverride = vi.fn();
    const model: RuntimeModel = {
      id: 'context-model',
      discoveredContextWindow: 128000,
      contextWindow: 128000,
      capabilityProvenance: { source: 'models.dev' },
    };
    render(
      <ModelCapabilityEditor
        model={model}
        onToggleModelInput={vi.fn()}
        onSetModelInputAuto={vi.fn()}
        onToggleModelOutput={vi.fn()}
        onSetModelOutputAuto={vi.fn()}
        onSetModelContextAuto={onAuto}
        onSetModelContextOverride={onOverride}
      />,
    );
    expect(screen.getByText('Discovered: 128,000 tokens')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('radio', { name: 'Manual' })[0]);
    expect(onAuto).toHaveBeenCalledWith('context-model', false);
    const input = screen.getByLabelText('Manual token limit') as HTMLInputElement;
    expect(input.parentElement?.classList.contains('settings-quantity-field')).toBe(true);
    expect(
      screen
        .getByLabelText('Output token limit')
        .parentElement?.classList.contains('settings-quantity-field'),
    ).toBe(true);
    fireEvent.change(input, { target: { value: '64000' } });
    expect(onOverride).toHaveBeenCalledWith('context-model', 64000);
  });

  it('keeps manual output capability checkboxes interactive and delegates toggles', () => {
    const onToggleModelOutput = vi.fn();
    const model: RuntimeModel = {
      id: 'text-model',
      acceptedOutput: ['text'],
      acceptedOutputOverride: ['text'],
    };
    render(
      <ModelCapabilityEditor
        model={model}
        onToggleModelInput={vi.fn()}
        onSetModelInputAuto={vi.fn()}
        onToggleModelOutput={onToggleModelOutput}
        onSetModelOutputAuto={vi.fn()}
      />,
    );

    const audio = screen.getByRole('checkbox', { name: 'Output audio' });
    expect(audio.hasAttribute('disabled')).toBe(false);
    expect(screen.getByRole('checkbox', { name: 'Output text' }).hasAttribute('checked')).toBe(
      true,
    );
    fireEvent.click(audio);
    expect(onToggleModelOutput).toHaveBeenCalledWith('text-model', 'audio');
    const gif = screen.getByRole('checkbox', { name: 'Output gif' }) as HTMLInputElement;
    expect(gif.disabled).toBe(false);
    fireEvent.click(gif);
    expect(onToggleModelOutput).toHaveBeenCalledWith('text-model', 'gif');
  });

  it('renders output manual changes when the editor state updates', () => {
    function Harness() {
      const [model, setModel] = React.useState<RuntimeModel>({
        id: 'text-model',
        acceptedOutput: ['text'],
        acceptedOutputOverride: ['text'],
      });
      return (
        <ModelCapabilityEditor
          model={model}
          onToggleModelInput={vi.fn()}
          onSetModelInputAuto={vi.fn()}
          onToggleModelOutput={(_, output) =>
            setModel((current) => {
              const acceptedOutput = current.acceptedOutput ?? [];
              const next = acceptedOutput.includes(output)
                ? acceptedOutput.filter((value) => value !== output)
                : [...acceptedOutput, output];
              return { ...current, acceptedOutput: next, acceptedOutputOverride: next };
            })
          }
          onSetModelOutputAuto={vi.fn()}
        />
      );
    }
    render(<Harness />);
    const audio = screen.getByRole('checkbox', { name: 'Output audio' }) as HTMLInputElement;
    const text = screen.getByRole('checkbox', { name: 'Output text' }) as HTMLInputElement;
    expect(text.checked).toBe(true);
    fireEvent.click(audio);
    expect(audio.checked).toBe(true);
    fireEvent.click(text);
    expect(text.checked).toBe(false);
    const gif = screen.getByRole('checkbox', { name: 'Output gif' }) as HTMLInputElement;
    fireEvent.click(gif);
    expect(gif.checked).toBe(true);
    fireEvent.click(gif);
    expect(gif.checked).toBe(false);
  });

  it('renders saved authentication details and delegates provider actions', () => {
    const provider = {
      id: 'openai',
      provider: 'OpenAI',
      apiType: 'openai-responses',
      url: 'https://example.test',
      apiKey: '',
      models: ['gpt-test'],
      oauthConfigured: true,
      authSource: 'browser',
    };
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    render(
      <SavedProviders
        providers={[provider]}
        open
        onOpenChange={vi.fn()}
        onEdit={onEdit}
        onDelete={onDelete}
      />,
    );

    expect(screen.getByText('OAuth configured')).toBeTruthy();
    expect(screen.queryByText('Source: browser')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /OpenAI.*OpenAI Responses.*1 model/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete OpenAI' }));
    expect(onEdit).toHaveBeenCalledWith(provider);
    expect(onDelete).toHaveBeenCalledWith(provider);
  });

  it('selects an expanded provider without a separate Edit action or verbose model list', () => {
    const provider = {
      id: 'openai',
      provider: 'OpenAI',
      apiType: 'openai-responses',
      url: 'https://example.test',
      apiKey: '',
      models: ['gpt-test'],
    };
    const onEdit = vi.fn();
    render(
      <SavedProviders
        providers={[provider]}
        open
        onOpenChange={vi.fn()}
        onEdit={onEdit}
        onDelete={vi.fn()}
        selectedId="openai"
        expanded
      />,
    );
    const selector = screen.getByRole('button', { name: /OpenAI.*OpenAI Responses.*1 model/ });
    expect(selector.getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByText('gpt-test')).toBeNull();
    fireEvent.click(selector);
    expect(onEdit).toHaveBeenCalledWith(provider);
  });

  it('normalizes known and unknown OAuth statuses for display', () => {
    expect(openAiLoginStatusLabel('waiting_for_callback')).toBe(
      'Finish signing in in your browser',
    );
    expect(openAiLoginStatusLabel('future_status')).toBe('future status');
    expect(claudeLoginStatusLabel('ready_to_import')).toBe('Ready to import');
    expect(claudeLoginStatusLabel()).toBe('Idle');
  });
});

describe('Google Developer API model metadata', () => {
  it('preserves unknown capabilities and false/zero provider values without inferring modalities', () => {
    render(
      <ModelCapabilityEditor
        model={{
          id: 'google-unknown',
          supportedGenerationMethods: [],
          googleMetadata: { thinking: false, temperature: 0, version: 'v1' },
        }}
        onToggleModelInput={vi.fn()}
        onSetModelInputAuto={vi.fn()}
        onToggleModelOutput={vi.fn()}
        onSetModelOutputAuto={vi.fn()}
      />,
    );
    expect(screen.getAllByText('Unknown')).toHaveLength(3);
    expect((screen.getByLabelText('Output token limit') as HTMLInputElement).value).toBe('Unknown');
    expect((screen.getByLabelText('Thinking') as HTMLTextAreaElement).value).toBe('false');
    expect((screen.getByLabelText('Temperature') as HTMLTextAreaElement).value).toBe('0');
    expect((screen.getByLabelText('Generation methods') as HTMLInputElement).value).toBe(
      'None reported',
    );
  });
  it('keeps scalar metadata compact and long or structured values full-width and selectable', () => {
    const longName = 'models/' + 'long-model-identifier-'.repeat(8);
    const { container } = render(
      <ModelCapabilityEditor
        model={{
          id: 'metadata-layout',
          supportedGenerationMethods: ['generateContent', 'countTokens'],
          googleMetadata: {
            name: longName,
            version: '001',
            description: 'Short description',
            thinking: false,
            temperature: 0,
            // Preserve additional fields if a provider extends its runtime metadata.
            ...{
              extra: { enabled: true },
              multiline: 'first\nsecond',
              absent: null,
              missing: undefined,
            },
          },
        }}
        onToggleModelInput={vi.fn()}
        onSetModelInputAuto={vi.fn()}
        onToggleModelOutput={vi.fn()}
        onSetModelOutputAuto={vi.fn()}
      />,
    );
    for (const [label, value] of [
      ['Version', '001'],
      ['Thinking', 'false'],
      ['Temperature', '0'],
    ]) {
      const control = screen.getByLabelText(label) as HTMLInputElement;
      expect(control.tagName).toBe('INPUT');
      expect(control.value).toBe(value);
      expect(control.readOnly).toBe(true);
      expect(control.disabled).toBe(false);
      expect(control.closest('.model-provider-metadata-wide')).toBeNull();
    }
    for (const label of ['Generation methods', 'Name', 'Description', 'Extra', 'Multiline']) {
      const control = screen.getByLabelText(label) as HTMLTextAreaElement;
      expect(control.tagName).toBe('TEXTAREA');
      expect(control.readOnly).toBe(true);
      expect(control.closest('.model-provider-metadata-wide')).toBeTruthy();
    }
    expect((screen.getByLabelText('Name') as HTMLTextAreaElement).value).toBe(longName);
    expect((screen.getByLabelText('Extra') as HTMLTextAreaElement).value).toBe('{"enabled":true}');
    expect(screen.queryByLabelText('Absent')).toBeNull();
    expect(screen.queryByLabelText('Missing')).toBeNull();
    expect(container.querySelector('.model-provider-metadata-grid')).toBeTruthy();
  });
  it('offers native API type and renders discovered methods and token limits', () => {
    expect(modelConnectionApiTypes).toContainEqual({
      value: 'google-generative-language',
      label: 'Google Gemini (Developer API)',
    });
    render(
      <ModelCapabilityEditor
        model={{
          id: 'models/gemini-test',
          supportedGenerationMethods: ['generateContent'],
          googleMetadata: {
            description: 'Test model',
            inputTokenLimit: 1234,
            outputTokenLimit: 321,
          },
          discoveredOutput: ['text'],
        }}
        onToggleModelInput={() => {}}
        onSetModelInputAuto={() => {}}
        onToggleModelOutput={() => {}}
        onSetModelOutputAuto={() => {}}
      />,
    );
    expect((screen.getByLabelText('Generation methods') as HTMLInputElement).value).toBe(
      'generateContent',
    );
    expect(screen.getByText('Provider metadata').parentElement?.hasAttribute('open')).toBe(false);
    expect(screen.queryByLabelText('Provider model metadata')).toBeNull();
    expect(screen.getByText('Discovered: 1,234 tokens')).toBeTruthy();
    expect((screen.getByLabelText('Output token limit') as HTMLInputElement).value).toBe('321');
  });
});

it('renders ten two-line model rows without repeated modalities and preserves independent controls', () => {
  const onSelectModel = vi.fn(),
    onToggleModel = vi.fn(),
    onDeleteManualModel = vi.fn();
  const models: RuntimeModel[] = Array.from({ length: 10 }, (_, index) => ({
    id: `model-${index}`,
    displayName: `Model ${index}`,
    selected: index === 0,
    manual: index === 9,
    discoveredInput: ['text'],
    discoveredOutput: ['text'],
  }));
  const { container } = render(
    <ModelResults
      compact
      models={models}
      manualModel=""
      selectedModelId="model-0"
      onSelectModel={onSelectModel}
      onToggleModel={onToggleModel}
      onDeleteManualModel={onDeleteManualModel}
      onManualModelChange={vi.fn()}
      onAddManualModel={vi.fn()}
    />,
  );
  expect(container.querySelectorAll('.model-option-compact')).toHaveLength(10);
  expect(container.querySelector('.model-option-summary')).toBeNull();
  expect(container.querySelectorAll('.model-option-select small')).toHaveLength(10);
  expect(container.querySelector('.model-option-select small')?.textContent).toBe('model-0');
  fireEvent.click(screen.getByRole('button', { name: 'Select Model 9 (model-9)' }));
  expect(onSelectModel).toHaveBeenCalledWith('model-9');
  expect(onToggleModel).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Use Model 9' }));
  expect(onToggleModel).toHaveBeenCalledWith('model-9');
  fireEvent.click(screen.getByRole('button', { name: 'Delete manually added model model-9' }));
  expect(onDeleteManualModel).toHaveBeenCalledWith('model-9');
});
