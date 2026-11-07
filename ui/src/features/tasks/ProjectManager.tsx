import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type SetStateAction,
  type Dispatch,
} from 'react';
import { AccessibleModal } from '../../app/AccessibleModal';
import { api } from '../../app/api';
import { useConfirm } from '../../app/ConfirmDialog';
import { newProjectDraft, type Project, type ProjectDraft } from './taskDomain';

export function ProjectManager({
  open,
  initiallyNew,
  onClose,
  projects,
  setProjects,
  onProjectCreated,
  onProjectDeleted,
  pending,
  setSaving,
  setError,
  taskSaving,
}: {
  open: boolean;
  initiallyNew: boolean;
  onClose: () => void;
  projects: Project[];
  setProjects: Dispatch<SetStateAction<Project[]>>;
  onProjectCreated: (id: string) => void;
  onProjectDeleted: (id: string) => void;
  pending: Set<symbol>;
  setSaving: (owner: symbol, value: boolean) => void;
  setError: Dispatch<SetStateAction<string>>;
  taskSaving: boolean;
}) {
  const confirm = useConfirm();
  const [projectDraft, storeProjectDraft] = useState<ProjectDraft | null>(
    initiallyNew ? { ...newProjectDraft(), owner: Symbol('project editor') } : null,
  );
  const projectRef = useRef<ProjectDraft | null>(projectDraft);
  function setProjectDraft(action: SetStateAction<ProjectDraft | null>) {
    const next = typeof action === 'function' ? action(projectRef.current) : action;
    projectRef.current = next ? { ...next, owner: next.owner ?? Symbol('project editor') } : null;
    storeProjectDraft(projectRef.current);
  }
  useEffect(() => {
    projectRef.current = projectDraft;
    return () => {
      projectRef.current = null;
    };
    // The ref is otherwise synchronously maintained by setProjectDraft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const saving = taskSaving || pending.has(projectDraft?.owner as symbol);

  async function saveProject(event: FormEvent<HTMLFormElement>) {
    const owner = projectRef.current?.owner;
    if (!owner) return;
    const owns = () => projectRef.current?.owner === owner;
    event.preventDefault();
    if (!projectDraft || pending.has(owner)) return;
    const submittedDraft = projectDraft;
    const body = {
      name: projectDraft.name,
      description: projectDraft.description,
      notes: projectDraft.notes,
      pathEntries: projectDraft.pathEntries.map((entry, index) => ({ ...entry, sortOrder: index })),
    };
    setSaving(owner, true);
    setError('');
    try {
      let savedProject: Project;
      if (projectDraft.id) {
        const result = await api<{ project: Project }>(
          `/api/task-board/projects/${encodeURIComponent(projectDraft.id)}`,
          {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          },
        );
        savedProject = result.project;
        setProjects((current) =>
          current.map((project) => (project.id === result.project.id ? result.project : project)),
        );
      } else {
        const result = await api<{ project: Project }>('/api/task-board/projects', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        savedProject = result.project;
        setProjects((current) =>
          [...current, result.project].sort((a, b) => a.name.localeCompare(b.name)),
        );
        if (owns()) onProjectCreated(result.project.id);
      }
      if (owns()) {
        if (projectRef.current === submittedDraft) setProjectDraft(null);
        else
          setProjectDraft((current) => (current ? { ...current, id: savedProject.id } : current));
      }
    } catch (saveError) {
      owns() && setError(`Could not save the project: ${(saveError as Error).message}`);
    } finally {
      setSaving(owner, false);
    }
  }

  async function deleteProject(project: Project) {
    if (
      !(await confirm({
        title: 'Delete project?',
        message: `Delete project “${project.name}” and all of its tasks?`,
        confirmLabel: 'Delete project',
        tone: 'danger',
      }))
    )
      return;
    const owner = Symbol('delete project');
    setSaving(owner, true);
    setError('');
    try {
      await api(`/api/task-board/projects/${encodeURIComponent(project.id)}`, { method: 'DELETE' });
      setProjects((current) => current.filter((item) => item.id !== project.id));
      onProjectDeleted(project.id);
    } catch (deleteError) {
      setError(`Could not delete the project: ${(deleteError as Error).message}`);
    } finally {
      setSaving(owner, false);
    }
  }

  return open ? (
    <div
      className="task-detail-backdrop"
      role="presentation"
      onMouseDown={() => {
        onClose();
        setProjectDraft(null);
      }}
    >
      <AccessibleModal
        className="project-manager-panel"
        role="dialog"
        aria-labelledby="project-manager-title"
        onMouseDown={(event) => event.stopPropagation()}
        onClose={() => {
          onClose();
          setProjectDraft(null);
        }}
      >
        <header className="task-detail-header">
          <div>
            <span className="eyebrow">CONFIGURATION</span>
            <h2 id="project-manager-title">Projects</h2>
          </div>
          <button
            className="task-modal-close"
            type="button"
            aria-label="Close project manager"
            onClick={() => {
              onClose();
              setProjectDraft(null);
            }}
          >
            ×
          </button>
        </header>
        <div className="project-manager-content">
          {projectDraft ? (
            <form className="project-form" onSubmit={saveProject}>
              <label className="task-form-field">
                <span>
                  Project name <b aria-hidden="true">*</b>
                </span>
                <input
                  autoFocus
                  required
                  value={projectDraft.name}
                  onChange={(event) =>
                    setProjectDraft({ ...projectDraft, name: event.target.value })
                  }
                />
              </label>
              <label className="task-form-field">
                <span>Description</span>
                <textarea
                  rows={4}
                  value={projectDraft.description}
                  onChange={(event) =>
                    setProjectDraft({ ...projectDraft, description: event.target.value })
                  }
                />
              </label>
              <label className="task-form-field">
                <span>Project notes</span>
                <textarea
                  rows={4}
                  value={projectDraft.notes}
                  onChange={(event) =>
                    setProjectDraft({ ...projectDraft, notes: event.target.value })
                  }
                  placeholder="Shared context for this project"
                />
              </label>
              <fieldset className="project-paths">
                <legend>Named paths</legend>
                <p className="hint">
                  Reference useful directories or files by label in project-scoped conversations.
                </p>
                {projectDraft.pathEntries.map((entry, index) => (
                  <div className="project-path-entry" key={index}>
                    <input
                      aria-label={`Path ${index + 1} label`}
                      placeholder="Label"
                      value={entry.label}
                      onChange={(event) =>
                        setProjectDraft({
                          ...projectDraft,
                          pathEntries: projectDraft.pathEntries.map((item, itemIndex) =>
                            itemIndex === index ? { ...item, label: event.target.value } : item,
                          ),
                        })
                      }
                    />
                    <input
                      aria-label={`Path ${index + 1} path`}
                      placeholder="Path"
                      value={entry.path}
                      onChange={(event) =>
                        setProjectDraft({
                          ...projectDraft,
                          pathEntries: projectDraft.pathEntries.map((item, itemIndex) =>
                            itemIndex === index ? { ...item, path: event.target.value } : item,
                          ),
                        })
                      }
                    />
                    <input
                      aria-label={`Path ${index + 1} note`}
                      placeholder="Note (optional)"
                      value={entry.note}
                      onChange={(event) =>
                        setProjectDraft({
                          ...projectDraft,
                          pathEntries: projectDraft.pathEntries.map((item, itemIndex) =>
                            itemIndex === index ? { ...item, note: event.target.value } : item,
                          ),
                        })
                      }
                    />
                    <button
                      className="project-path-remove"
                      type="button"
                      aria-label={`Remove path ${index + 1}`}
                      onClick={() =>
                        setProjectDraft({
                          ...projectDraft,
                          pathEntries: projectDraft.pathEntries.filter(
                            (_, itemIndex) => itemIndex !== index,
                          ),
                        })
                      }
                    >
                      Remove
                    </button>
                  </div>
                ))}
                <button
                  className="project-path-add secondary"
                  type="button"
                  onClick={() =>
                    setProjectDraft({
                      ...projectDraft,
                      pathEntries: [
                        ...projectDraft.pathEntries,
                        {
                          label: '',
                          path: '',
                          note: '',
                          sortOrder: projectDraft.pathEntries.length,
                        },
                      ],
                    })
                  }
                >
                  ＋ Add path
                </button>
              </fieldset>
              <footer>
                <button type="button" onClick={() => setProjectDraft(null)}>
                  Cancel
                </button>
                <button className="primary" disabled={saving} type="submit">
                  {saving ? 'Saving…' : projectDraft.id ? 'Save project' : 'Add project'}
                </button>
              </footer>
            </form>
          ) : (
            <>
              <button
                className="primary project-add"
                type="button"
                onClick={() => setProjectDraft(newProjectDraft())}
              >
                ＋ Add project
              </button>
              <div className="project-list">
                {projects.map((project) => (
                  <article className="project-row" key={project.id}>
                    <div>
                      <strong>{project.name}</strong>
                      {project.description && <p>{project.description}</p>}
                    </div>
                    <div>
                      <button
                        type="button"
                        onClick={() => setProjectDraft(newProjectDraft(project))}
                      >
                        Edit
                      </button>
                      <button
                        className="task-delete"
                        type="button"
                        disabled={saving}
                        onClick={() => void deleteProject(project)}
                      >
                        Delete
                      </button>
                    </div>
                  </article>
                ))}
                {!projects.length && <p className="kanban-empty">No configured projects.</p>}
              </div>
            </>
          )}
        </div>
      </AccessibleModal>
    </div>
  ) : null;
}
