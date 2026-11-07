import { useEffect, useRef, useState, type FormEvent, type SetStateAction } from 'react';
import { api, jsonMutation } from '../../app/api';
import { useConfirm } from '../../app/ConfirmDialog';
import { uploadTaskDocument } from './TaskActivity';
import {
  taskDraft,
  reconcileEditor,
  reconcileSavedDraft,
  type BoardTask,
  type Project,
  type TaskDraft,
  type TaskEditorState,
} from './taskDomain';

/** Owns board IO and task-opening continuations together. Polling updates the board only;
 * editor reconciliation remains exclusive to the owning save/execute continuation. */
export function useTaskWorkflow(onDispatch?: (sessionId: string, agentId: string) => void) {
  const confirm = useConfirm();
  const [projects, setProjects] = useState<Project[]>([]);
  const [tasks, setTasks] = useState<BoardTask[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState('');
  // Each opening owns its continuations, even when the same record is reopened.
  const [editor, storeEditor] = useState<TaskEditorState | null>(null);
  const editorRef = useRef<TaskEditorState | null>(null);
  function setEditor(action: SetStateAction<TaskEditorState | null>) {
    const next = typeof action === 'function' ? action(editorRef.current) : action;
    editorRef.current = next ? { ...next, owner: next.owner ?? Symbol('task editor') } : null;
    storeEditor(editorRef.current);
  }
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<Set<symbol>>(new Set());
  const saving = pending.has(editor?.owner as symbol);
  const setSaving = (owner: symbol, value: boolean) =>
    setPending((current) => {
      const next = new Set(current);
      if (value) next.add(owner);
      else next.delete(owner);
      return next;
    });
  const [error, setError] = useState('');
  const documentInput = useRef<HTMLInputElement>(null);

  async function loadBoard() {
    setLoading(true);
    setError('');
    try {
      const [projectResult, taskResult] = await Promise.all([
        api<{ projects: Project[] }>('/api/task-board/projects'),
        api<{ tasks: BoardTask[] }>('/api/task-board/tasks'),
      ]);
      setProjects(projectResult.projects);
      setTasks(taskResult.tasks);
    } catch (loadError) {
      setError(`Could not load the task board: ${(loadError as Error).message}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadBoard();
  }, []);
  // The archive boundary can pass while the board is open; the server owns it.
  useEffect(() => {
    const abort = new AbortController();
    const timer = window.setInterval(() => {
      void api<{ tasks: BoardTask[] }>('/api/task-board/tasks', { signal: abort.signal })
        .then((result) => {
          if (!abort.signal.aborted) setTasks(result.tasks);
        })
        .catch(() => {});
    }, 60_000);
    return () => {
      abort.abort();
      window.clearInterval(timer);
    };
  }, []);

  const editingTask = editor?.mode === 'edit' ? editor.task : null;

  const draft =
    editor?.draft ??
    taskDraft(editingTask ?? undefined, selectedProjectId || projects[0]?.id || '');
  const changeDraft = (key: keyof TaskDraft, value: string) =>
    setEditor((current) =>
      current
        ? {
            ...current,
            draft: {
              ...(current.draft ??
                taskDraft(
                  current.mode === 'edit' ? current.task : undefined,
                  selectedProjectId || projects[0]?.id || '',
                )),
              [key]: key === 'assignedAgentId' ? value || null : value,
            },
          }
        : current,
    );

  async function saveTask(event: FormEvent<HTMLFormElement>) {
    const owner = editorRef.current?.owner;
    if (!owner) return;
    const owns = () => editorRef.current?.owner === owner;
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const projectId = String(form.get('projectId') ?? '');
    if (!projectId) {
      setError('Choose a project before saving the task.');
      return;
    }
    const payload = {
      projectId,
      title: String(form.get('title') ?? ''),
      description: String(form.get('description') ?? ''),
      status: String(form.get('status') ?? 'todo'),
      priority: String(form.get('priority') ?? 'normal'),
      assignedAgentId: draft.assignedAgentId,
    };
    if (pending.has(owner)) return;
    const submittedDraft = editorRef.current?.draft;
    const files = [...(editorRef.current?.files ?? [])];
    setSaving(owner, true);
    setError('');
    let savedTask: BoardTask | null = null;
    try {
      if (editingTask) {
        const result = await api<{ task: BoardTask }>(
          `/api/task-board/tasks/${encodeURIComponent(editingTask.id)}`,
          {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          },
        );
        savedTask = result.task;
        setTasks((current) =>
          current.map((task) => (task.id === result.task.id ? result.task : task)),
        );
      } else {
        const result = await api<{ task: BoardTask }>('/api/task-board/tasks', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        savedTask = result.task;
        setTasks((current) => [result.task, ...current]);
      }
      while (files.length) {
        await uploadTaskDocument(savedTask!.id, files[0]);
        files.shift();
      }
      if (owns()) {
        if (editorRef.current?.draft === submittedDraft) setEditor(null);
        else
          setEditor((current) =>
            current && savedTask
              ? reconcileSavedDraft(current, savedTask, submittedDraft, files)
              : current,
          );
      }
    } catch (saveError) {
      if (owns() && savedTask) {
        const persistedTask = savedTask;
        setEditor((current) =>
          current ? reconcileSavedDraft(current, persistedTask, submittedDraft, files) : current,
        );
      }
      owns() &&
        setError(
          `${savedTask ? 'Task saved, but a document could not be attached. Save changes to retry remaining documents' : 'Could not save the task'}: ${(saveError as Error).message}`,
        );
    } finally {
      setSaving(owner, false);
    }
  }

  async function deleteTask() {
    const owner = editorRef.current?.owner;
    if (!owner) return;
    const owns = () => editorRef.current?.owner === owner;
    if (
      !editingTask ||
      !(await confirm({
        title: 'Delete task?',
        message: `Delete “${editingTask.title}”?`,
        confirmLabel: 'Delete task',
        tone: 'danger',
      }))
    )
      return;
    if (!owns()) return;
    setSaving(owner, true);
    setError('');
    try {
      await api(`/api/task-board/tasks/${encodeURIComponent(editingTask.id)}`, {
        method: 'DELETE',
      });
      setTasks((current) => current.filter((task) => task.id !== editingTask.id));
      if (owns()) setEditor(null);
    } catch (deleteError) {
      owns() && setError(`Could not delete the task: ${(deleteError as Error).message}`);
    } finally {
      setSaving(owner, false);
    }
  }

  async function executeTask() {
    const owner = editorRef.current?.owner;
    if (!owner) return;
    const owns = () => editorRef.current?.owner === owner;
    if (!editingTask) return;
    if (JSON.stringify(draft) !== JSON.stringify(taskDraft(editingTask))) {
      setError(
        'Save changes before executing. Execute uses the saved task, not the unsaved draft.',
      );
      return;
    }
    setSaving(owner, true);
    setError('');
    try {
      const result = await api<{
        task: BoardTask;
        execution?: { runId?: string; agentId?: string; sessionId?: string };
      }>(
        `/api/task-board/tasks/${encodeURIComponent(editingTask.id)}/execute`,
        jsonMutation('POST'),
      );
      setTasks((current) =>
        current.map((task) => (task.id === result.task.id ? result.task : task)),
      );
      if (owns()) setEditor((current) => reconcileEditor(current, result.task));
      if (owns() && result.execution?.sessionId && result.execution.agentId)
        onDispatch?.(result.execution.sessionId, result.execution.agentId);
    } catch (executeError) {
      owns() && setError(`Could not execute the task: ${(executeError as Error).message}`);
    } finally {
      setSaving(owner, false);
    }
  }

  return {
    projects,
    setProjects,
    tasks,
    setTasks,
    selectedProjectId,
    setSelectedProjectId,
    editor,
    setEditor,
    loading,
    pending,
    saving,
    setSaving,
    error,
    setError,
    documentInput,
    editingTask,
    draft,
    changeDraft,
    saveTask,
    deleteTask,
    executeTask,
  };
}
