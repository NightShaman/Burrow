export type ProjectPathEntry = { label: string; path: string; note: string; sortOrder: number };
export type Project = {
  id: string;
  name: string;
  description?: string;
  notes?: string;
  pathEntries?: ProjectPathEntry[];
};

export function normalizePathEntries(project: Project): ProjectPathEntry[] {
  return (project.pathEntries ?? []).map((entry, index) => ({
    label: entry.label ?? '',
    path: entry.path ?? '',
    note: entry.note ?? '',
    sortOrder: Number.isFinite(entry.sortOrder) ? entry.sortOrder : index,
  }));
}
export type BoardTask = {
  id: string;
  projectId: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  assignedAgentId: string | null;
  metadata: Record<string, unknown>;
  execution?: {
    runId?: string;
    status?: string;
    ok?: boolean;
    error?: string | null;
    executedAt?: string | null;
    result?: { answerText?: string | null; blockers?: string[] };
  } | null;
  createdAt: string;
  updatedAt: string;
  archived?: boolean;
  archivedAt?: string | null;
};

export type TaskDraft = Pick<
  BoardTask,
  'title' | 'description' | 'status' | 'priority' | 'assignedAgentId' | 'projectId'
>;
export type TaskEditorState = ({ mode: 'create' } | { mode: 'edit'; task: BoardTask }) & {
  draft?: TaskDraft;
  owner?: symbol;
  files?: File[];
};
export const taskDraft = (task?: BoardTask, projectId = ''): TaskDraft => ({
  title: task?.title ?? '',
  description: task?.description ?? '',
  status: task?.status ?? 'todo',
  priority: task?.priority ?? 'normal',
  assignedAgentId: task?.assignedAgentId ?? null,
  projectId: task?.projectId ?? projectId,
});
export function reconcileEditor(
  current: TaskEditorState | null,
  task: BoardTask,
): TaskEditorState | null {
  if (current?.mode !== 'edit' || current.task.id !== task.id) return current;
  const draft = taskDraft(task);
  const previous = taskDraft(current.task);
  for (const key of Object.keys(draft) as Array<keyof TaskDraft>) {
    if (current.draft && current.draft[key] !== previous[key])
      Object.assign(draft, { [key]: current.draft[key] });
  }
  return { ...current, task, draft };
}
export function reconcileSavedDraft(
  current: TaskEditorState,
  savedTask: BoardTask,
  submittedDraft: TaskDraft | undefined,
  files: File[],
): TaskEditorState {
  const previous = submittedDraft ?? taskDraft(current.mode === 'edit' ? current.task : undefined);
  const draft = taskDraft(savedTask);
  for (const key of Object.keys(draft) as Array<keyof TaskDraft>) {
    if (current.draft && current.draft[key] !== previous[key])
      Object.assign(draft, { [key]: current.draft[key] });
  }
  return { mode: 'edit', task: savedTask, owner: current.owner, draft, files };
}
export type ProjectDraft = {
  owner?: symbol;
  id?: string;
  name: string;
  description: string;
  notes: string;
  pathEntries: ProjectPathEntry[];
};

export const newProjectDraft = (project?: Project): ProjectDraft => ({
  id: project?.id,
  name: project?.name ?? '',
  description: project?.description ?? '',
  notes: project?.notes ?? '',
  pathEntries: normalizePathEntries(project ?? { id: '', name: '' }),
});
