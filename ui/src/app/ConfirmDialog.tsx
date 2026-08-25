import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

type ConfirmOptions = { title: string; message: string; confirmLabel?: string; tone?: 'danger' | 'default' };
type ConfirmContextValue = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmContextValue | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<(ConfirmOptions & { resolve: (value: boolean) => void }) | null>(null);
  const confirm = useCallback((options: ConfirmOptions) => new Promise<boolean>((resolve) => setRequest({ ...options, resolve })), []);
  const finish = (value: boolean) => { request?.resolve(value); setRequest(null); };

  useEffect(() => {
    if (!request) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') finish(false); };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [request]);

  return <ConfirmContext.Provider value={confirm}>{children}{request && <div className="confirm-dialog-backdrop" role="presentation" onMouseDown={() => finish(false)}><section className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-dialog-title" aria-describedby="confirm-dialog-message" onMouseDown={(event) => event.stopPropagation()}><div className="confirm-dialog-mark" aria-hidden="true">!</div><div className="confirm-dialog-content"><span className="eyebrow">CONFIRM ACTION</span><h2 id="confirm-dialog-title">{request.title}</h2><p id="confirm-dialog-message">{request.message}</p><div className="confirm-dialog-actions"><button className="secondary" type="button" onClick={() => finish(false)}>Cancel</button><button className={request.tone === 'danger' ? 'danger' : 'primary'} type="button" autoFocus onClick={() => finish(true)}>{request.confirmLabel ?? 'Confirm'}</button></div></div></section></div>}</ConfirmContext.Provider>;
}

export function useConfirm() {
  const context = useContext(ConfirmContext);
  if (!context) throw new Error('useConfirm must be used within ConfirmProvider');
  return context;
}
