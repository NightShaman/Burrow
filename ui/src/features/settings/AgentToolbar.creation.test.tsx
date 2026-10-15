import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AgentToolbar } from './AgentToolbar';
import { api } from '../../app/api';
vi.mock('../../app/api', async original => ({ ...await original<typeof import('../../app/api')>(), api: vi.fn() }));
afterEach(() => { cleanup(); localStorage.clear(); vi.resetAllMocks(); });
const callbacks = () => ({ onSelect: vi.fn(), onAgentsChanged: vi.fn(async () => {}), onModelConnectionsChanged: vi.fn(async () => {}), onSetupComplete: vi.fn(async () => {}) });
function open(props = callbacks()) {
  const view = render(<AgentToolbar agents={[]} selectedId="" {...props} />);
  fireEvent.click(screen.getByText('New Agent'));
  fireEvent.change(screen.getByLabelText('ID'), { target: { value: 'new-agent' } });
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'New agent' } });
  return { view, props };
}
it('empty configured registry creates an ordinary agent without reading setup identity or fetching OAuth/models', async () => {
  localStorage.setItem('hc.setupOperation', '{"retained":"must not be touched"}');
  vi.mocked(api).mockResolvedValue({ agent: { id: 'new-agent' } });
  const { props } = open();
  expect(screen.queryByText('Start fresh')).toBeNull();
  await act(async () => fireEvent.click(screen.getByText('Create agent')));
  expect(api).toHaveBeenCalledTimes(1);
  expect(api).toHaveBeenCalledWith('/api/agents', expect.objectContaining({ method: 'POST', body: JSON.stringify({ id: 'new-agent', name: 'New agent', enabled: true }) }));
  expect(props.onSelect).toHaveBeenCalledWith('new-agent');
  expect(props.onModelConnectionsChanged).not.toHaveBeenCalled(); expect(props.onSetupComplete).not.toHaveBeenCalled();
  expect(localStorage.getItem('hc.setupOperation')).toBe('{"retained":"must not be touched"}');
});
it('cancel releases drafts and failed creation retries without leaking into setup', async () => {
  vi.mocked(api).mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ agent: { id: 'new-agent' } });
  open();
  await act(async () => fireEvent.click(screen.getByText('Create agent')));
  expect(screen.getByRole('alert').textContent).toContain('offline');
  await act(async () => fireEvent.click(screen.getByText('Create agent')));
  expect(api).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.click(screen.getByText('New Agent'));
  expect((screen.getByLabelText('ID') as HTMLInputElement).value).toBe('');
  fireEvent.click(screen.getByText('Cancel'));
  expect(screen.queryByRole('dialog')).toBeNull();
});
it('blocks duplicate in-flight writes and ignores unmounted completion callbacks', async () => {
  let resolve!: (value: unknown) => void;
  vi.mocked(api).mockReturnValue(new Promise(r => { resolve = r; }));
  const { view, props } = open();
  fireEvent.click(screen.getByText('Create agent'));
  fireEvent.click(screen.getByText('Creating…'));
  expect(api).toHaveBeenCalledTimes(1);
  view.unmount();
  await act(async () => resolve({ agent: { id: 'new-agent' } }));
  expect(props.onAgentsChanged).not.toHaveBeenCalled(); expect(props.onSelect).not.toHaveBeenCalled();
});
it('retries a failed registry refresh without creating the already-confirmed agent twice', async () => {
  vi.mocked(api).mockResolvedValue({ agent: { id: 'new-agent' } });
  const props = callbacks(); props.onAgentsChanged.mockRejectedValueOnce(new Error('refresh offline'));
  open(props);
  await act(async () => fireEvent.click(screen.getByText('Create agent')));
  expect(screen.getByRole('alert').textContent).toContain('Agent created');
  await act(async () => fireEvent.click(screen.getByText('Retry refresh')));
  expect(api).toHaveBeenCalledTimes(1); expect(props.onAgentsChanged).toHaveBeenCalledTimes(2);
  expect(props.onSelect).toHaveBeenCalledWith('new-agent');
});
