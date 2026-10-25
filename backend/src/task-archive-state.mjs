// Archive is a reversible projection of completion, never a status or deletion.
export const TASK_ARCHIVE_DELAY_MS = 2 * 24 * 60 * 60 * 1000;
export function taskArchiveState(task, at = new Date()) {
  if (task.status !== 'done') return { archived: false, archivedAt: null };
  const completed = new Date(task.terminalAt || task.updatedAt || task.createdAt).getTime();
  const deadline = completed + TASK_ARCHIVE_DELAY_MS;
  const archived = Number.isFinite(deadline) && deadline <= new Date(at).getTime();
  return { archived, archivedAt: archived ? new Date(deadline).toISOString() : null };
}
