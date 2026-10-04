import { fireEvent, render, screen, cleanup } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { AccessibleModal } from './AccessibleModal';
import { ConfirmProvider, useConfirm } from './ConfirmDialog';
afterEach(cleanup);
it('isolates background, focuses Cancel, traps Tab and restores opener', () => {
 const opener = document.createElement('button'); document.body.append(opener); opener.focus();
 let closed = false;
 const view = render(<AccessibleModal role="dialog" onClose={() => { closed = true; }}><button>Delete</button><button>Cancel</button></AccessibleModal>);
 expect(document.activeElement).toBe(screen.getByText('Cancel')); expect(opener.inert).toBe(true);
 fireEvent.keyDown(document.activeElement!, { key: 'Tab' }); expect(document.activeElement).toBe(screen.getByText('Delete'));
 fireEvent.keyDown(document, { key: 'Escape' }); expect(closed).toBe(true);
 view.unmount(); expect(opener.inert).toBeFalsy(); expect(document.activeElement).toBe(opener); opener.remove();
});
it('queues concurrent confirmation requests without losing their resolutions', async () => {
 const results: boolean[] = [];
 function Harness() { const confirm = useConfirm(); return <button onClick={() => { void confirm({title:'First',message:'1'}).then(result => results.push(result)); void confirm({title:'Second',message:'2'}).then(result => results.push(result)); }}>Queue</button>; }
 render(<ConfirmProvider><Harness /></ConfirmProvider>); fireEvent.click(screen.getByText('Queue'));
 expect(screen.getByText('First')).toBeTruthy(); fireEvent.click(screen.getByText('Cancel'));
 expect(screen.getByText('Second')).toBeTruthy(); expect(document.activeElement).toBe(screen.getByText('Cancel'));
 fireEvent.click(screen.getByText('Confirm')); await Promise.resolve(); expect(results).toEqual([false,true]);
});
