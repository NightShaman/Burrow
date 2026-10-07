import { useLayoutEffect, useRef, type HTMLAttributes } from 'react';
import { createPortal } from 'react-dom';

const modalStack: HTMLElement[] = [];
const backgroundInert = new Map<HTMLElement, boolean>();
let originalOverflow = '';
function syncModalIsolation() {
  const top = modalStack.at(-1);
  for (const node of Array.from(document.body.children) as HTMLElement[]) {
    if (!backgroundInert.has(node)) backgroundInert.set(node, node.inert);
    node.inert = top ? node !== top : backgroundInert.get(node)!;
  }
  if (!top) { backgroundInert.clear(); document.body.style.overflow = originalOverflow; }
}

// Keep existing dialog markup and styling; isolate its portal from the application.
export function AccessibleModal({ onClose, children, ...props }: HTMLAttributes<HTMLElement> & { onClose: () => void }) {
  const host = useRef<HTMLDivElement | null>(null);
  if (!host.current) host.current = document.createElement('div');
  const dialog = useRef<HTMLElement>(null);
  const close = useRef(onClose); close.current = onClose;
  useLayoutEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const container = host.current!;
    container.className = 'accessible-modal-backdrop';
    container.addEventListener('click', event => { if (isTop() && event.target === container) close.current(); });
    document.body.append(container);
    modalStack.push(container);
    const isTop = () => modalStack.at(-1) === container;
    if (modalStack.length === 1) originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    syncModalIsolation();
    const focusables = () => Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"]') ?? []).filter(node => !node.hidden && !node.closest('[hidden]'));
    const initial = focusables();
    (initial.find(node => node.getAttribute('aria-label') === 'Close image viewer') ?? initial.find(node => node.textContent?.trim() === 'Cancel') ?? initial[0] ?? dialog.current)?.focus();
    const key = (event: KeyboardEvent) => {
      if (!isTop()) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close.current(); }
      if (event.key === 'Tab') {
        const items = focusables(); const index = items.indexOf(document.activeElement as HTMLElement);
        if (!items.length) { event.preventDefault(); dialog.current?.focus(); }
        else if (index < 0 || (event.shiftKey ? index === 0 : index === items.length - 1)) { event.preventDefault(); items[event.shiftKey ? items.length - 1 : 0].focus(); }
      }
    };
    const focus = (event: FocusEvent) => { if (isTop() && !container.contains(event.target as Node)) (focusables()[0] ?? dialog.current)?.focus(); };
    document.addEventListener('keydown', key, true); document.addEventListener('focusin', focus);
    return () => {
      document.removeEventListener('keydown', key, true); document.removeEventListener('focusin', focus);
      modalStack.splice(modalStack.indexOf(container), 1);
      container.remove(); backgroundInert.delete(container);
      syncModalIsolation();
      if (opener?.isConnected && !opener.closest('[inert]')) opener.focus();
    };
  }, []);
  return createPortal(<section {...props} ref={dialog} tabIndex={-1} aria-modal="true">{children}</section>, host.current);
}
