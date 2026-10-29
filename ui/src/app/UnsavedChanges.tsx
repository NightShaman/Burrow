import { createContext, useCallback, useContext, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { AccessibleModal } from './AccessibleModal';

type Draft = { dirty: boolean; busy: boolean; save: () => Promise<boolean>; discard: () => void; resumeAfterAutosave?: boolean };
type Registration = { current: Draft };
type Navigation = (proceed: () => void) => void;
const Context = createContext<{ register: (draft: Registration) => () => void; changed: () => void; navigate: Navigation }>({
  register: () => () => {}, changed: () => {}, navigate: proceed => proceed(),
});

// Explicit navigation boundaries call this shared guard; ordinary controls and
// immediate actions are not intercepted. Drafts remain memory-only in the form.
export function UnsavedChangesProvider({ children }: { children: ReactNode }) {
  const active = useRef(new Set<Registration>());
  const pending = useRef<(() => void) | null>(null);
  const saving = useRef(false);
  const waiting = useRef(false);
  const queuedResumeNeedsOptIn = useRef(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const register = useCallback((draft: Registration) => {
    active.current.add(draft);
    return () => { active.current.delete(draft); };
  }, []);
  // Blur may start an autosave before a navigation button receives its click.
  // Retain the first destination and observe the committed draft state instead
  // of dropping the click or calling save again while that mutation is running.
  const changed = useCallback(() => {
    if (!waiting.current || !pending.current) return;
    const drafts = [...active.current];
    if (drafts.some(draft => draft.current.busy)) { setBusy(true); return; }
    setBusy(false);
    waiting.current = false;
    if (drafts.some(draft => draft.current.dirty)) { setOpen(true); return; }
    // Queued navigation is exceptional: only autosave scopes that explicitly
    // opt in may resume it after their draft becomes clean. Operations with a
    // post-success state the user must see (for example one-time token reveal)
    // default to cancelling this stale destination.
    const canResume = !queuedResumeNeedsOptIn.current
      || drafts.some(draft => draft.current.resumeAfterAutosave === true);
    const proceed = pending.current;
    pending.current = null;
    queuedResumeNeedsOptIn.current = false;
    if (canResume) proceed();
  }, []);
  const navigate = useCallback<Navigation>(proceed => {
    if (pending.current) return;
    const drafts = [...active.current];
    // Busy clean operations stay put. A dirty autosave may queue one original
    // destination only when its registration explicitly permits resumption.
    const busyDrafts = drafts.filter(draft => draft.current.busy);
    if (busyDrafts.length
      && !busyDrafts.some(draft => draft.current.dirty && draft.current.resumeAfterAutosave === true)) return;
    pending.current = proceed;
    waiting.current = true;
    queuedResumeNeedsOptIn.current = busyDrafts.length > 0;
    changed();
  }, [changed]);
  useLayoutEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if ([...active.current].some(draft => draft.current.dirty || draft.current.busy)) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, []);
  const stay = () => { if (saving.current) return; waiting.current = false; queuedResumeNeedsOptIn.current = false; pending.current = null; setOpen(false); };
  const finish = async (save: boolean) => {
    if (saving.current) return;
    const registrations = [...active.current];
    // Opening/focusing the modal can blur an editor and start its autosave.
    // Recheck live busy state before either Save or Discard; the modal remains
    // locked until that mutation settles and changed() publishes the outcome.
    if (registrations.some(draft => draft.current.busy)) {
      waiting.current = true;
      setBusy(true);
      queueMicrotask(changed);
      return;
    }
    const drafts = registrations.filter(draft => draft.current.dirty);
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
  return <Context.Provider value={{ register, changed, navigate }}>{children}{open && <AccessibleModal data-unsaved-changes-modal className="confirm-dialog" role="alertdialog" aria-labelledby="unsaved-title" aria-describedby="unsaved-message" onClose={stay}>
    <div className="confirm-dialog-mark" aria-hidden="true">!</div><div className="confirm-dialog-content"><h2 id="unsaved-title">Unsaved changes</h2><p id="unsaved-message">Save your changes before leaving?</p><div className="confirm-dialog-actions">
      <button className="secondary" type="button" disabled={busy} onClick={stay}>Stay</button>
      <button className="danger" type="button" disabled={busy} onClick={() => void finish(false)}>Discard</button>
      <button className="primary" type="button" disabled={busy} onClick={() => void finish(true)}>{busy ? 'Saving…' : 'Save'}</button>
    </div></div>
  </AccessibleModal>}</Context.Provider>;
}

export function isUnsavedChangesModalTarget(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest('[data-unsaved-changes-modal]'));
}
export function useUnsavedNavigation() { return useContext(Context).navigate; }
export function useUnsavedChanges(draft: Draft) {
  const { register, changed } = useContext(Context);
  const latest = useRef(draft);
  // Read all registrations only after sibling layout effects have published
  // their state, so a partial commit cannot prematurely resume navigation.
  useLayoutEffect(() => { latest.current = draft; queueMicrotask(changed); });
  useLayoutEffect(() => register(latest), [register]);
}
