import { useState, type Dispatch, type SetStateAction } from 'react';
import type { Tab } from '../../app/types';

export function Editor({
  tab,
  setTabs,
  onSave,
}: {
  tab: Tab;
  setTabs: Dispatch<SetStateAction<Tab[]>>;
  onSave: (tab: Tab, content: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const loaded = tab.fileLoaded === true && !tab.fileLoading && !tab.fileError;
  const save = async () => {
    if (!loaded) return;
    setSaving(true);
    setError('');
    try {
      await onSave(tab, tab.content ?? '');
      setEditing(false);
    } catch (error) {
      setError(`Could not save ${tab.label}: ${(error as Error).message}`);
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="editor-view">
      <div className="editor-toolbar">
        <span>{tab.path ?? tab.id}</span>
        <button
          className={editing ? 'save' : ''}
          onClick={editing ? save : () => setEditing(true)}
          disabled={saving || !loaded}
        >
          {saving ? 'Saving…' : editing ? 'Save' : 'Edit'}
        </button>
      </div>
      {tab.fileLoading && <p role="status">Loading…</p>}
      {tab.fileError && (
        <p className="error" role="alert">
          {tab.fileError}
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <textarea
        className="editor"
        value={tab.content}
        readOnly={!editing || saving || !loaded}
        onChange={(event) =>
          setTabs((all) =>
            all.map((item) =>
              item.id === tab.id ? { ...item, content: event.target.value } : item,
            ),
          )
        }
        spellCheck={false}
        aria-label={`Edit ${tab.label}`}
      />
    </div>
  );
}
