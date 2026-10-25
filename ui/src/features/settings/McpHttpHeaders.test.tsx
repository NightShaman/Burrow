import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../app/api';
import { ConfirmProvider } from '../../app/ConfirmDialog';
import { McpConnections } from './McpConnections';
import { serializeHttpHeaders, validateHttpHeaders, type HttpHeaderRow } from './McpHttpHeaders';
vi.mock('../../app/api', async original => ({ ...(await original<typeof import('../../app/api')>()), api: vi.fn() }));
afterEach(() => { cleanup(); vi.mocked(api).mockReset(); });
const row = (patch: Partial<HttpHeaderRow> = {}): HttpHeaderRow => ({ rowId: 1, name: 'X-Token', value: '', configured: true, replacing: false, ...patch });
const connection = { id: 'headers', name: 'Header server', transport: 'http', baseUrl: 'https://example.test/mcp', args: [], tools: [], headerNames: ['X-Token', 'X-Tenant'] };
const renderEditor = async () => {
  vi.mocked(api).mockResolvedValue({ connections: [connection] });
  render(<ConfirmProvider><McpConnections /></ConfirmProvider>);
  fireEvent.click(await screen.findByRole('button', { name: 'Edit Header server' }));
};
const savedBody = () => JSON.parse(String(vi.mocked(api).mock.calls.find(([, init]) => init?.method === 'POST')?.[1]?.body));
describe('HTTP header payload', () => {
  it('preserves configured values, replaces explicitly, omits empty drafts, and clears with an empty map', () => {
    expect(serializeHttpHeaders([row(), row({ name: 'X-Tenant', replacing: true, value: 'opaque' }), row({ name: '', configured: false })])).toEqual({ 'X-Token': null, 'X-Tenant': 'opaque' });
    expect(serializeHttpHeaders([])).toEqual({});
  });
  it('validates names, case-insensitive duplicates, size limits and control characters', () => {
    expect(validateHttpHeaders([row({ name: 'Bad Name' })])).toContain('valid HTTP header name');
    expect(validateHttpHeaders([row(), row({ name: 'x-token' })])).toContain('Duplicate');
    expect(validateHttpHeaders([row({ replacing: true })])).toBeNull();
    expect(serializeHttpHeaders([row({ replacing: true })])).toEqual({ 'X-Token': '' });
    expect(validateHttpHeaders([row({ name: 'X'.repeat(129) })])).toContain('valid HTTP header name');
    expect(validateHttpHeaders([row({ replacing: true, value: 'é'.repeat(4097) })])).toContain('8192 bytes');
    expect(validateHttpHeaders(Array.from({ length: 65 }, (_, i) => row({ name: `X-${i}` } )))).toContain('64 HTTP headers');
    expect(validateHttpHeaders([row({ replacing: true, value: 'one\r\ntwo' })])).toContain('line breaks');
    expect(validateHttpHeaders([row(), row({ name: 'X-Tenant', value: 'new', configured: false })])).toBeNull();
  });
});
describe('HTTP header editor', () => {
  it('shows only saved names, masks new values, and preserves both secrets on an unrelated save', async () => {
    await renderEditor();
    const secret = screen.getByLabelText('HTTP header 1 value') as HTMLInputElement;
    expect(secret.value).toBe(''); expect(secret.type).toBe('password'); expect(secret.readOnly).toBe(true);
    expect((screen.getByLabelText('HTTP header 1 name') as HTMLInputElement).readOnly).toBe(true);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(savedBody().headers).toEqual({ 'X-Token': null, 'X-Tenant': null }));
  });
  it('requires explicit replace, supports cancelling it, and removes individual headers', async () => {
    await renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Replace X-Token' }));
    const secret = screen.getByLabelText('HTTP header 1 value') as HTMLInputElement;
    expect(secret.readOnly).toBe(false);
    fireEvent.change(secret, { target: { value: 'discard-me' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel replacement of X-Token' }));
    expect(secret.value).toBe(''); expect(secret.readOnly).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Replace X-Token' }));
    fireEvent.change(secret, { target: { value: 'replacement' } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove X-Tenant' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(savedBody().headers).toEqual({ 'X-Token': 'replacement' }));
  });
  it('sends {} after explicitly removing all saved headers', async () => {
    await renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Remove X-Token' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove X-Tenant' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(savedBody().headers).toEqual({}));
  });
  it('adds stable name/value rows and rejects duplicate names before writing', async () => {
    await renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Add header' }));
    const name = screen.getByLabelText('HTTP header 3 name'); name.focus();
    fireEvent.change(name, { target: { value: 'x-token' } }); expect(document.activeElement).toBe(name);
    fireEvent.change(screen.getByLabelText('HTTP header 3 value'), { target: { value: 'new-secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(screen.getByRole('alert').textContent).toContain('Duplicate');
    expect(vi.mocked(api).mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
  });
  it('keeps stdio writes free of HTTP headers', async () => {
    await renderEditor();
    fireEvent.change(screen.getByLabelText('Transport'), { target: { value: 'stdio' } });
    expect(screen.queryByRole('button', { name: 'Add header' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'npx' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(savedBody().command).toBe('npx'));
    expect(savedBody()).not.toHaveProperty('headers');
  });
});
