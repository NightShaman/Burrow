export const TASK_STATUSES = Object.freeze(['backlog', 'todo', 'in_progress', 'review', 'done', 'cancelled']);
export const TASK_PRIORITIES = Object.freeze(['critical', 'high', 'normal', 'low']);

// Compatibility export only; persistence requires the PostgreSQL store.
export class TaskBoardStore {
  constructor() { throw new Error('postgres_required'); }
}
