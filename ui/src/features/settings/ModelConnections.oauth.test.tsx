import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { SavedProvider } from '../../app/types';
import { ModelConnections } from './ModelConnections';

vi.mock('../../app/ConfirmDialog', () => ({ useConfirm: () => vi.fn() }));
afterEach(cleanup);

it('shows masked replacement tokens only for an edited OAuth Responses connection, clearing on switch and cancel', () => {
  const base: SavedProvider = { id: 'oauth', provider: 'OAuth account', apiType: 'openai-responses', url: 'https://example.test', apiKey: '', models: ['model'], auth: { provider: 'OpenAI' } };
  const key = { ...base, id: 'key', provider: 'Key account', auth: { type: 'api_key' } };
  render(<ModelConnections savedProviders={[base, key]} onModelConnectionsChanged={vi.fn().mockResolvedValue(undefined)} mcpConnections={null} />);
  expect(screen.queryByLabelText('OpenAI ID token')).toBeNull();
  fireEvent.click(screen.getByText('Saved providers'));
  fireEvent.click(screen.getByRole('button', { name: /OAuth account.*1 model/ }));
  for (const label of ['OpenAI ID token', 'OpenAI access token', 'OpenAI refresh token']) {
    const input = screen.getByLabelText(label) as HTMLInputElement;
    expect(input.type).toBe('password');
    expect(input.autocomplete).toBe('off');
    expect(input.value).toBe('');
    fireEvent.change(input, { target: { value: 'draft-secret' } });
  }
  fireEvent.change(screen.getByLabelText('API type'), { target: { value: 'anthropic-messages' } });
  expect(screen.queryByLabelText('OpenAI ID token')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /Key account.*1 model/ }));
  expect(screen.queryByLabelText('OpenAI ID token')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /OAuth account.*1 model/ }));
  expect((screen.getByLabelText('OpenAI access token') as HTMLInputElement).value).toBe('');
  fireEvent.change(screen.getByLabelText('OpenAI ID token'), { target: { value: 'cancel-secret' } });
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByLabelText('OpenAI ID token')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /OAuth account.*1 model/ }));
  expect((screen.getByLabelText('OpenAI ID token') as HTMLInputElement).value).toBe('');
});
