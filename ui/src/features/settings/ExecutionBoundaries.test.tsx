import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../app/api';
import { ExecutionBoundaries } from './ExecutionBoundaries';

vi.mock('../../app/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../app/api')>()),
  api: vi.fn(),
}));

const apiMock = vi.mocked(api);
const response = (hardBlocks: Array<Record<string, unknown>> = []) => ({ boundaries: { version: 1 as const, hardBlocks } });

afterEach(cleanup);

describe('ExecutionBoundaries', () => {
  beforeEach(() => apiMock.mockReset());

  it('loads boundaries and saves edited rules through the settings API', async () => {
    apiMock.mockResolvedValueOnce(response([{ id: 'readonly', enabled: true, type: 'path', pattern: '/backup/**', match: 'glob', operations: ['write'] }]))
      .mockResolvedValueOnce(response([{ id: 'readonly', enabled: true, type: 'path', pattern: '/archive/**', match: 'glob', operations: ['write'] }]));

    render(<ExecutionBoundaries />);
    const pattern = await screen.findByDisplayValue('/backup/**');
    fireEvent.change(pattern, { target: { value: '/archive/**' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save boundaries' }));

    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(2));
    expect(apiMock).toHaveBeenNthCalledWith(1, '/api/settings/execution-boundaries', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(apiMock).toHaveBeenNthCalledWith(2, '/api/settings/execution-boundaries', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({ hardBlocks: [{ id: 'readonly', enabled: true, type: 'path', pattern: '/archive/**', match: 'glob', operations: ['write'] }] }),
    }));
  });

  it('aborts initial loading when the component unmounts', () => {
    let signal: AbortSignal | undefined;
    apiMock.mockImplementationOnce((_path, init) => {
      signal = init?.signal ?? undefined;
      return new Promise(() => undefined);
    });

    const view = render(<ExecutionBoundaries />);
    expect(signal?.aborted).toBe(false);
    act(() => view.unmount());
    expect(signal?.aborted).toBe(true);
  });

  it('supports adding and removing boundary rules locally', async () => {
    apiMock.mockResolvedValueOnce(response());
    render(<ExecutionBoundaries />);
    await screen.findByText('No hard blocks are configured.');

    fireEvent.click(screen.getByRole('button', { name: 'Add hard block' }));
    expect(screen.getByPlaceholderText('/mnt/backup/**')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove boundary' }));
    expect(screen.getByText('No hard blocks are configured.')).toBeTruthy();
  });
});
