import { AccessibleModal } from './AccessibleModal';
import { createContext, useCallback, useContext, useEffect, useState, useRef, type ReactNode } from 'react';

type ConfirmOptions = { title: string; message: string; confirmLabel?: string; tone?: 'danger' | 'default' };
type ConfirmContextValue = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmContextValue | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [requests, setRequests] = useState<Array<ConfirmOptions & { resolve: (value: boolean) => void }>>([]);
  const request = requests[0];
  const confirm = useCallback((options: ConfirmOptions) => new Promise<boolean>((resolve) => setRequests(queue => [...queue, { ...options, resolve }])), []);
  const finish = (value: boolean) => { request?.resolve(value); setRequests(queue => queue.slice(1)); };
  const pending = useRef(requests); pending.current = requests;
  useEffect(() => () => { pending.current.forEach(item => item.resolve(false)); }, []);

  return <ConfirmContext.Provider value={confirm}>{children}{request && <div className="confirm-dialog-backdrop" role="presentation" onMouseDown={() => finish(false)}><AccessibleModal className="confirm-dialog" role="alertdialog" aria-labelledby="confirm-dialog-title" aria-describedby="confirm-dialog-message" onMouseDown={(event) => event.stopPropagation()} onClose={() => finish(false)}><div className="confirm-dialog-mark" aria-hidden="true">!</div><div className="confirm-dialog-content"><span className="eyebrow">CONFIRM ACTION</span><h2 id="confirm-dialog-title">{request.title}</h2><p id="confirm-dialog-message">{request.message}</p><div className="confirm-dialog-actions"><button className="secondary" type="button" onClick={() => finish(false)}>Cancel</button><button className={request.tone === 'danger' ? 'danger' : 'primary'} type="button" onClick={() => finish(true)}>{request.confirmLabel ?? 'Confirm'}</button></div></div></AccessibleModal></div>}</ConfirmContext.Provider>;
}

export function useConfirm() {
  const context = useContext(ConfirmContext);
  if (!context) throw new Error('useConfirm must be used within ConfirmProvider');
  return context;
}
