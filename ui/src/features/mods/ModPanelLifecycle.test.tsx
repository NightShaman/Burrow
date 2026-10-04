import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ModPanelHost } from './ModPanelHost';
const { mountControl } = vi.hoisted(() => ({ mountControl: vi.fn() }));
vi.mock('./ModPanelLifecycleFixture', () => ({ mountControl }));
const panel = { modId: 'fixture', name: 'Fixture', controlUrl: './ModPanelLifecycleFixture' };
afterEach(() => { cleanup(); mountControl.mockReset(); });
it('FE038 contains synchronous panel mount failures', async () => {
 mountControl.mockImplementation(() => { throw new Error('panel sync failure'); });
 render(<ModPanelHost panel={panel}/>);
 expect((await screen.findByRole('alert')).textContent).toContain('panel sync failure');
});
it('FE038 superseded panel detaches late writes and cleans late mount once', async () => {
 let finish!: (cleanup: () => void) => void;
 mountControl.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockImplementation(() => undefined);
 const view = render(<ModPanelHost panel={panel}/>);
 await waitFor(() => expect(mountControl).toHaveBeenCalledTimes(1));
 const oldRoot = mountControl.mock.calls[0][0].root as HTMLElement;
 view.rerender(<ModPanelHost panel={{...panel, modId: 'replacement'}}/>);
 await waitFor(() => expect(mountControl).toHaveBeenCalledTimes(2));
 oldRoot.textContent = 'obsolete panel';
 const dispose = vi.fn(() => { throw new Error('cleanup failure'); });
 await act(async () => { finish(dispose); });
 expect(dispose).toHaveBeenCalledTimes(1);
 expect(oldRoot.isConnected).toBe(false);
 expect(screen.queryByText('obsolete panel')).toBeNull();
});
