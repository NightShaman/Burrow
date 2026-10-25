import { createContext, useCallback, useContext, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { AccessibleModal } from './AccessibleModal';

type Draft = { dirty: boolean; busy: boolean; save: () => Promise<boolean>; discard: () => void };
type Registration = { current: Draft };
type Navigation = (proceed: () => void) => void;
const Context = createContext<{ register: (draft: Registration) => () => void; navigate: Navigation }>({
  register: () => () => {}, navigate: proceed => proceed(),
});

// Explicit navigation boundaries call this shared guard; ordinary controls and
// immediate actions are not intercepted. Drafts remain memory-only in the form.
export function UnsavedChangesProvider({ children }: { children: ReactNode }) {
  const active = useRef(new Set<Registration>());
  const pending = useRef<(() => void) | null>(null);
  const saving = useRef(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const register = useCallback((draft: Registration) => {
    active.current.add(draft);
    return () => { active.current.delete(draft); };
  }, []);
  const navigate = useCallback<Navigation>(proceed => {
    if (pending.current || [...active.current].some(draft => draft.current.busy)) return;
    if (![...active.current].some(draft => draft.current.dirty)) { proceed(); return; }
    pending.current = proceed;
    setOpen(true);
  }, []);
  useLayoutEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if ([...active.current].some(draft => draft.current.dirty || draft.current.busy)) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, []);
  const stay = () => { if (saving.current) return; pending.current = null; setOpen(false); };
  const finish = async (save: boolean) => {
    if (saving.current) return;
    const drafts = [...active.current].filter(draft => draft.current.dirty);
    const proceed = pending.current;
    if (!proceed) { stay(); return; }
    if (save) {
      saving.current = true; setBusy(true);
      let succeeded = true;
      for (const draft of drafts) {
        if (!active.current.has(draft)) { succeeded = false; break; }
        try { if (!await draft.current.save()) { succeeded = false; break; } }
        catch { succeeded = false; break; } // The form owns the actionable error.
      }
      saving.current = false; setBusy(false);
      if (!succeeded) { stay(); return; }
    } else drafts.forEach(draft => draft.current.discard());
    pending.current = null; setOpen(false); proceed();
  };
  return <Context.Provider value={{ register, navigate }}>{children}{open && <AccessibleModal className="confirm-dialog" role="alertdialog" aria-labelledby="unsaved-title" aria-describedby="unsaved-message" onClose={stay}>
    <div className="confirm-dialog-mark" aria-hidden="true">!</div><div className="confirm-dialog-content"><h2 id="unsaved-title">Unsaved changes</h2><p id="unsaved-message">Save your changes before leaving?</p><div className="confirm-dialog-actions">
      <button className="secondary" type="button" disabled={busy} onClick={stay}>Stay</button>
      <button className="danger" type="button" disabled={busy} onClick={() => void finish(false)}>Discard</button>
      <button className="primary" type="button" disabled={busy} onClick={() => void finish(true)}>{busy ? 'Saving…' : 'Save'}</button>
    </div></div>
  </AccessibleModal>}</Context.Provider>;
}

export function useUnsavedNavigation() { return useContext(Context).navigate; }
export function useUnsavedChanges(draft: Draft) {
  const { register } = useContext(Context);
  const latest = useRef(draft);
  useLayoutEffect(() => { latest.current = draft; });
  useLayoutEffect(() => register(latest), [register]);
}
