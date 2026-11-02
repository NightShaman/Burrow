import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../../app/api';
import { UnsavedChangesProvider } from '../../app/UnsavedChanges';
import type { SavedProvider } from '../../app/types';
import { ModelConnections } from './ModelConnections';

vi.mock('../../app/api', async (original) => ({
  ...(await original<typeof import('../../app/api')>()),
  api: vi.fn(),
}));
vi.mock('../../app/ConfirmDialog', () => ({ useConfirm: () => vi.fn() }));
afterEach(() => {
  cleanup();
  vi.mocked(api).mockReset();
});

const providers: SavedProvider[] = [
  {
    id: 'first',
    provider: 'First provider',
    apiType: 'openai-responses',
    url: 'https://first.invalid',
    apiKey: '',
    models: ['general', 'vision'],
    connectionModels: [
      { id: 'general', selected: true, discoveredInput: ['text'], discoveredOutput: ['text'] },
      {
        id: 'vision',
        selected: true,
        discoveredInput: ['text', 'image'],
        discoveredOutput: ['text'],
      },
    ],
  },
  {
    id: 'second',
    provider: 'Second provider',
    apiType: 'anthropic-messages',
    url: 'https://second.invalid',
    apiKey: '',
    models: ['reasoner'],
  },
];

it('keeps all providers visible and renders model selection beside its editor without an overflow portal', () => {
  const overflow = document.createElement('div');
  document.body.append(overflow);
  const view = render(
    <ModelConnections
      savedProviders={providers}
      onModelConnectionsChanged={async () => {}}
      mcpConnections={null}
      overflowTarget={overflow}
    />,
  );
  const inventory = screen.getByRole('region', { name: 'Saved providers' });
  expect(inventory.closest('.models-provider-column')).toBeTruthy();
  expect(
    screen.getByRole('region', { name: 'Provider connection' }).closest('.models-editor-column'),
  ).toBeTruthy();
  expect(within(inventory).getByRole('button', { name: /First provider.*2 models/ })).toBeTruthy();
  expect(within(inventory).getByRole('button', { name: /Second provider.*1 model/ })).toBeTruthy();
  expect(inventory.querySelector('details')).toBeNull();
  fireEvent.click(within(inventory).getByRole('button', { name: /First provider.*2 models/ }));
  const catalog = screen.getByRole('region', { name: 'Provider models' });
  fireEvent.click(within(catalog).getByRole('button', { name: 'Select vision' }));
  const details = within(catalog).getByRole('region', { name: 'Model details' });
  expect(within(details).getByRole('heading', { name: 'vision' })).toBeTruthy();
  expect(within(details).getByText('Discovered: text, image')).toBeTruthy();
  expect(overflow.childElementCount).toBe(0);
  view.unmount();
  overflow.remove();
});

it('guards Add provider when the current connection has an unsaved draft', () => {
  render(
    <UnsavedChangesProvider>
      <ModelConnections
        savedProviders={providers}
        onModelConnectionsChanged={async () => {}}
        mcpConnections={null}
      />
    </UnsavedChangesProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: /First provider.*2 models/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Edit connection' }));
  fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'Unsaved name' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add provider' }));
  expect(screen.getByRole('alertdialog')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Stay' }));
  expect((screen.getByLabelText('Provider') as HTMLInputElement).value).toBe('Unsaved name');
  fireEvent.click(screen.getByRole('button', { name: 'Add provider' }));
  fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
  expect((screen.getByLabelText('Provider') as HTMLInputElement).value).toBe('');
  expect(screen.queryByRole('region', { name: 'Provider models' })).toBeNull();
});

it('collapses saved setup without hiding Save, discovery, or a failed save', async () => {
  vi.mocked(api).mockRejectedValue(new Error('Synthetic save failure'));
  render(
    <ModelConnections
      savedProviders={providers}
      onModelConnectionsChanged={async () => {}}
      mcpConnections={null}
    />,
  );
  expect(document.getElementById('models-connection-fields')?.hidden).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: /First provider.*2 models/ }));
  expect(
    screen.getByRole('button', { name: 'Edit connection' }).getAttribute('aria-expanded'),
  ).toBe('false');
  expect(document.getElementById('models-connection-fields')?.hidden).toBe(true);
  expect(screen.getByRole('button', { name: 'Connect' })).toBeTruthy();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Use vision' }));
  fireEvent.click(screen.getByRole('button', { name: 'Select vision' }));
  expect((screen.getByRole('checkbox', { name: 'Use vision' }) as HTMLInputElement).checked).toBe(
    false,
  );
  expect(screen.getByRole('heading', { name: 'vision' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() =>
    expect(screen.getByRole('alert').textContent).toContain('Synthetic save failure'),
  );
  expect(screen.getByRole('alert').closest('[hidden]')).toBeNull();
  const body = JSON.parse(String(vi.mocked(api).mock.calls[0][1]?.body));
  expect(body.id).toBe('first');
  expect(body.models.find((model: { id: string }) => model.id === 'vision').selected).toBe(false);
  expect(body.models.find((model: { id: string }) => model.id === 'general').selected).toBe(true);
});

it('retains the mounted connection draft across disclosure and rejected navigation', () => {
  render(
    <UnsavedChangesProvider>
      <ModelConnections
        savedProviders={providers}
        onModelConnectionsChanged={async () => {}}
        mcpConnections={null}
      />
    </UnsavedChangesProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: /First provider.*2 models/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Edit connection' }));
  const input = screen.getByLabelText('Provider');
  fireEvent.change(input, { target: { value: 'Draft provider' } });
  fireEvent.click(screen.getByRole('button', { name: 'Hide connection' }));
  fireEvent.click(screen.getByRole('button', { name: /Second provider.*1 model/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Stay' }));
  fireEvent.click(screen.getByRole('button', { name: 'Edit connection' }));
  expect(screen.getByLabelText('Provider')).toBe(input);
  expect((input as HTMLInputElement).value).toBe('Draft provider');
});
