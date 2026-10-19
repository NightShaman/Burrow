import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../../app/api';
import { GlobalProfileDocuments } from './GlobalProfileDocuments';
import { AgentProfileDocuments } from './AgentProfileDocuments';

vi.mock('../../app/api', async original => ({ ...(await original<typeof import('../../app/api')>()), api: vi.fn() }));
const apiMock = vi.mocked(api);
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it('edits and saves the complete Global Rules and Orientation set', async () => {
  apiMock.mockImplementation(async (_path, init) => init?.method === 'PUT'
    ? { documents: [{ kind: 'RULES', markdown: 'Changed rules' }, { kind: 'ORIENTATION', markdown: 'Global orientation' }] }
    : { documents: [{ kind: 'RULES', markdown: 'Global rules' }, { kind: 'ORIENTATION', markdown: 'Global orientation' }] });
  const overflow = document.createElement('div');
  document.body.append(overflow);
  render(<GlobalProfileDocuments overflowTarget={overflow} />);
  await screen.findByRole('button', { name: 'Global Rules' });
  const rules = screen.getByLabelText('Markdown');
  expect(rules).toHaveProperty('value', 'Global rules');
  expect(screen.queryByLabelText('Global Orientation')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Global Orientation' }));
  expect(screen.getByLabelText('Markdown')).toHaveProperty('value', 'Global orientation');
  fireEvent.click(screen.getByRole('button', { name: 'Global Rules' }));
  fireEvent.change(screen.getByLabelText('Markdown'), { target: { value: 'Changed rules' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save Global documents' }));
  await waitFor(() => expect(apiMock.mock.calls.some(([path, init]) => path === '/api/settings/global-profile-documents' && init?.method === 'PUT')).toBe(true));
  const [, init] = apiMock.mock.calls.find(([, request]) => request?.method === 'PUT')!;
  expect(JSON.parse(init?.body as string)).toEqual({ documents: [{ kind: 'RULES', markdown: 'Changed rules' }, { kind: 'ORIENTATION', markdown: 'Global orientation' }] });
  overflow.remove();
});

it('saves independent include-global controls with clear composition copy', async () => {
  apiMock.mockImplementation(async (_path, init) => init?.method === 'PUT' ? {} : {
    documents: [
      { kind: 'SOUL', markdown: 'Soul' }, { kind: 'RULES', markdown: 'Local rules' }, { kind: 'ORIENTATION', markdown: 'Local orientation' },
      { kind: 'PREFERENCES', markdown: '' }, { kind: 'TOOLS', markdown: '' }, { kind: 'DREAM_MEMORY', markdown: '' },
    ],
    globalProfile: { useGlobalRules: true, useGlobalOrientation: false },
  });
  const overflow = document.createElement('div');
  document.body.append(overflow);
  try {
    render(<AgentProfileDocuments agentId="smatchet" overflowTarget={overflow} />);
    const rules = await screen.findByRole('checkbox', { name: /Include Global Rules/ });
    const orientation = screen.getByRole('checkbox', { name: /Include Global Orientation/ });
    expect(rules).toHaveProperty('checked', true);
    expect(orientation).toHaveProperty('checked', false);
    expect(screen.getByText('Global Rules first, then this agent’s RULES.md.')).toBeTruthy();
    expect(screen.getByText('Use only this agent’s ORIENTATION.md.')).toBeTruthy();
    fireEvent.click(rules);
    fireEvent.click(orientation);
    fireEvent.click(screen.getByRole('button', { name: 'Save profile documents' }));
    await waitFor(() => expect(apiMock.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(true));
    const [, init] = apiMock.mock.calls.find(([, request]) => request?.method === 'PUT')!;
    expect(JSON.parse(init?.body as string).globalProfile).toEqual({ useGlobalRules: false, useGlobalOrientation: true });
  } finally { overflow.remove(); }
});
