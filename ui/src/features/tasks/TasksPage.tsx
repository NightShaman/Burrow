import { ProjectManager } from './ProjectManager';
import { enabledAgents } from '../../app/agentCatalog';
import { TaskActivity } from './TaskActivity';
import { AccessibleModal } from '../../app/AccessibleModal';
import { useMemo, useState } from 'react';
import type { Agent } from '../../app/types';
import { useTaskWorkflow } from './useTaskWorkflow';

export type { BoardTask, Project, ProjectPathEntry } from './taskDomain';

const columns = [
  { id: 'backlog', title: 'Backlog' },
  { id: 'todo', title: 'To Do' },
  { id: 'in_progress', title: 'In Progress' },
  { id: 'review', title: 'Review' },
  { id: 'done', title: 'Done' },
];

const statusLabel = (status: string) =>
  status.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
const priorityLabel = (priority: string) =>
  priority.replace(/\b\w/g, (letter) => letter.toUpperCase());

export function Tasks({
  agents,
  onDispatch,
}: {
  agents: Agent[];
  onDispatch?: (sessionId: string, agentId: string) => void;
}) {
  const {
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
  } = useTaskWorkflow(onDispatch);
  const [search, setSearch] = useState('');
  const [showProjects, setShowProjects] = useState(false);
  const [newProjectOnOpen, setNewProjectOnOpen] = useState(false);

  const visibleTasks = useMemo(() => {
    const query = search.trim().toLowerCase();
    return tasks.filter((task) => {
      if (task.archived) return false;
      if (selectedProjectId && task.projectId !== selectedProjectId) return false;
      return (
        !query ||
        [task.title, task.description, task.priority, statusLabel(task.status)].some((value) =>
          value.toLowerCase().includes(query),
        )
      );
    });
  }, [tasks, selectedProjectId, search]);

  const projectFor = (projectId: string) => projects.find((project) => project.id === projectId);
  // Remote agent IDs are target-qualified for UI identity, but the selected
  // runtime task board owns and validates its unqualified resource ID.
  const agentFor = (agentId: string | null) =>
    agents.find((agent) => (agent.resourceId ?? agent.id) === agentId);

  return (
    <div className="tasks-page-shell">
      <div className="page-view tasks-page">
        <div className="task-toolbar">
          <label className="task-search">
            <span className="sr-only">Search tasks</span>
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search tasks"
            />
          </label>
          <div className="task-project-controls">
            <label className="task-project-select">
              <span>Project</span>
              <select
                value={selectedProjectId}
                onChange={(event) => setSelectedProjectId(event.target.value)}
              >
                <option value="">All projects</option>
                {projects.map((project) => (
                  <option value={project.id} key={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="task-heading-actions">
              <button
                className="secondary"
                type="button"
                onClick={() => {
                  setShowProjects(true);
                  setNewProjectOnOpen(false);
                }}
              >
                Manage projects
              </button>
              <button
                className="primary"
                type="button"
                disabled={!projects.length}
                onClick={() => setEditor({ mode: 'create' })}
              >
                ＋ New task
              </button>
            </div>
          </div>
        </div>
        {error && (
          <p className="task-board-error" role="alert">
            {error}
          </p>
        )}
        {!loading && !projects.length && (
          <section className="task-empty-state">
            <h2>No projects yet</h2>
            <p>Create a project before adding work to the board.</p>
            <button
              className="primary"
              type="button"
              onClick={() => {
                setShowProjects(true);
                setNewProjectOnOpen(true);
              }}
            >
              Add project
            </button>
          </section>
        )}
        {loading ? (
          <p className="task-loading">Loading task board…</p>
        ) : (
          projects.length > 0 && (
            <div className="kanban-board" aria-label="Task board">
              {columns.map((column) => {
                const columnTasks = visibleTasks.filter((task) => task.status === column.id);
                return (
                  <section className="kanban-column" key={column.id}>
                    <header>
                      <span>{column.title}</span>
                      <strong>{columnTasks.length}</strong>
                    </header>
                    <div className="kanban-cards">
                      {columnTasks.map((task) => (
                        <button
                          className="task-card"
                          type="button"
                          key={task.id}
                          onClick={() => setEditor({ mode: 'edit', task })}
                        >
                          <span className={`task-priority ${task.priority}`}>
                            {priorityLabel(task.priority)}
                          </span>
                          <strong>{task.title}</strong>
                          <small>{projectFor(task.projectId)?.name ?? 'Unknown project'}</small>
                          <small>
                            Owner · {agentFor(task.assignedAgentId)?.name ?? 'Unassigned'}
                          </small>
                        </button>
                      ))}
                      {columnTasks.length === 0 && <p className="kanban-empty">No tasks</p>}
                    </div>
                  </section>
                );
              })}
            </div>
          )
        )}
        {showProjects && (
          <ProjectManager
            open
            initiallyNew={newProjectOnOpen}
            onClose={() => setShowProjects(false)}
            projects={projects}
            setProjects={setProjects}
            pending={pending}
            setSaving={setSaving}
            setError={setError}
            taskSaving={saving}
            onProjectCreated={setSelectedProjectId}
            onProjectDeleted={(id) => {
              setTasks((current) => current.filter((task) => task.projectId !== id));
              setSelectedProjectId((current) => (current === id ? '' : current));
            }}
          />
        )}
        {editor && (
          <div
            className="task-detail-backdrop"
            role="presentation"
            onMouseDown={() => setEditor(null)}
          >
            <AccessibleModal
              className="task-detail-panel"
              role="dialog"
              aria-labelledby="task-editor-title"
              onMouseDown={(event) => event.stopPropagation()}
              onClose={() => setEditor(null)}
            >
              <header className="task-detail-header">
                <div>
                  <span className="eyebrow">{editingTask ? 'TASK DETAILS' : 'NEW TASK'}</span>
                  <h2 id="task-editor-title">{editingTask ? 'Edit task' : 'New task'}</h2>
                </div>
                <button
                  className="task-modal-close"
                  type="button"
                  aria-label="Close task editor"
                  onClick={() => setEditor(null)}
                >
                  ×
                </button>
              </header>
              <form className="task-detail-form" onSubmit={saveTask}>
                <label className="task-form-field">
                  <span>
                    Title <b aria-hidden="true">*</b>
                  </span>
                  <input
                    required
                    name="title"
                    value={draft.title}
                    onChange={(event) => changeDraft('title', event.target.value)}
                  />
                </label>
                <label className="task-form-field">
                  <span>Description</span>
                  <textarea
                    name="description"
                    rows={3}
                    value={draft.description}
                    onChange={(event) => changeDraft('description', event.target.value)}
                  />
                </label>
                <div className="task-form-grid">
                  <label className="task-form-field">
                    <span>Status</span>
                    <select
                      name="status"
                      value={draft.status}
                      onChange={(event) => changeDraft('status', event.target.value)}
                    >
                      {columns.map((column) => (
                        <option key={column.id} value={column.id}>
                          {column.title}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="task-form-field">
                    <span>Priority</span>
                    <select
                      name="priority"
                      value={draft.priority}
                      onChange={(event) => changeDraft('priority', event.target.value)}
                    >
                      {['critical', 'high', 'normal', 'low'].map((priority) => (
                        <option key={priority} value={priority}>
                          {priorityLabel(priority)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="task-form-field">
                    <span>Assignee</span>
                    <select
                      name="assignedAgentId"
                      value={draft.assignedAgentId ?? ''}
                      onChange={(event) => changeDraft('assignedAgentId', event.target.value)}
                    >
                      <option value="">Unassigned</option>
                      {draft.assignedAgentId &&
                        !enabledAgents(agents).some(
                          (agent) => (agent.resourceId ?? agent.id) === draft.assignedAgentId,
                        ) && (
                          <option hidden value={draft.assignedAgentId}>
                            Keep current assignment
                          </option>
                        )}
                      {enabledAgents(agents).map((agent) => (
                        <option value={agent.resourceId ?? agent.id} key={agent.id}>
                          {agent.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="task-form-field">
                    <span>
                      Project <b aria-hidden="true">*</b>
                    </span>
                    <select
                      required
                      name="projectId"
                      value={draft.projectId}
                      onChange={(event) => changeDraft('projectId', event.target.value)}
                    >
                      {projects.map((project) => (
                        <option value={project.id} key={project.id}>
                          {project.name}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                {editingTask && (
                  <p>Execute uses the saved task. Save any changes before executing.</p>
                )}
                <footer className="task-detail-actions">
                  {editingTask && (
                    <button
                      className="task-execute"
                      disabled={
                        saving ||
                        !editingTask.assignedAgentId ||
                        ['done', 'cancelled'].includes(editingTask.status)
                      }
                      type="button"
                      onClick={() => void executeTask()}
                    >
                      ▷ Execute
                    </button>
                  )}
                  <div className="task-editor-primary-actions">
                    {editingTask && (
                      <button
                        className="task-delete"
                        disabled={saving}
                        type="button"
                        onClick={() => void deleteTask()}
                      >
                        ⌫ Delete
                      </button>
                    )}
                    <button className="primary" disabled={saving} type="submit">
                      {saving ? 'Saving…' : editingTask ? 'Save changes' : 'Create task'}
                    </button>
                  </div>
                </footer>
              </form>
              {editingTask ? (
                <TaskActivity
                  key={editingTask.id}
                  taskId={editingTask.id}
                  revision={editingTask.updatedAt}
                />
              ) : (
                <div className="task-activity">
                  <section aria-labelledby="new-task-documents">
                    <header className="task-activity-heading">
                      <h3 id="new-task-documents">Documents</h3>
                      <button
                        className="task-attach-button"
                        type="button"
                        disabled={saving}
                        onClick={() => documentInput.current?.click()}
                      >
                        ＋ Attach document
                      </button>
                    </header>
                    <input
                      ref={documentInput}
                      hidden
                      type="file"
                      multiple
                      aria-label="Attach document"
                      disabled={saving}
                      onChange={(event) => {
                        const files = Array.from(event.target.files ?? []);
                        event.target.value = '';
                        setEditor((current) =>
                          current
                            ? { ...current, files: [...(current.files ?? []), ...files] }
                            : current,
                        );
                      }}
                    />
                  </section>
                </div>
              )}
              {Boolean(editor.files?.length) && (
                <ul className="task-document-list task-activity">
                  {editor.files!.map((file, index) => (
                    <li key={index}>
                      <div>
                        <strong>{file.name}</strong>
                        <small>{new Intl.NumberFormat().format(file.size)} bytes</small>
                      </div>
                      <button
                        type="button"
                        aria-label={`Remove ${file.name}`}
                        disabled={saving}
                        onClick={() =>
                          setEditor((current) =>
                            current
                              ? { ...current, files: current.files?.filter((_, i) => i !== index) }
                              : current,
                          )
                        }
                      >
                        Remove<span className="sr-only"> {file.name}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </AccessibleModal>
          </div>
        )}
      </div>
    </div>
  );
}
