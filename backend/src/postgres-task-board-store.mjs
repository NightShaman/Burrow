import { randomUUID } from "node:crypto";
import { TASK_STATUSES, TASK_PRIORITIES } from "./task-board-store.mjs";
export { TASK_STATUSES, TASK_PRIORITIES };
import {
  closePostgresPool,
  withPostgresTransaction,
} from "./postgres-foundation.mjs";

const STATUS_SET = new Set(TASK_STATUSES);
const PRIORITY_SET = new Set(TASK_PRIORITIES);
const text = (v) => String(v ?? "").trim();
const now = () => new Date().toISOString();
const id = (v, field) => {
  const s = text(v);
  if (!/^[A-Za-z0-9._-]{1,96}$/.test(s)) throw new Error(`${field}_invalid`);
  return s;
};
const parseJson = (v) => {
  if (v && typeof v === "object") return v;
  try {
    return JSON.parse(v || "{}");
  } catch {
    return {};
  }
};
const json = (v) => JSON.stringify(v ?? {});
const actorId = (v) => {
  const s = text(v);
  return s ? id(s, "task_actor_agent_id") : null;
};
const strip = (m = {}) =>
  Object.fromEntries(
    Object.entries(m || {}).filter(
      ([k]) => !["createdBy", "editedBy"].includes(k),
    ),
  );
const actorEntry = (agentId, at, extra = {}) => ({
  agentId: actorId(agentId),
  at,
  ...extra,
});
const edited = (m = {}) =>
  Array.isArray(m.editedBy)
    ? m.editedBy.filter((x) => x && typeof x === "object").slice(-99)
    : [];
function createdMetadata(m, actorAgentId, at) {
  return { ...strip(m), createdBy: actorEntry(actorAgentId, at), editedBy: [] };
}
function editedMetadata(current, next, { actorAgentId, at, fields }) {
  return {
    ...strip(next),
    ...(current.createdBy && typeof current.createdBy === "object"
      ? { createdBy: current.createdBy }
      : {}),
    editedBy: [
      ...edited(current),
      actorEntry(actorAgentId, at, {
        action: "update",
        fields: fields.map(text).filter(Boolean).slice(0, 24),
      }),
    ],
  };
}
function projectRow(r, paths = []) {
  return (
    r && {
      id: r.id,
      name: r.name,
      description: r.description || "",
      notes: r.notes || "",
      pathEntries: paths,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }
  );
}
function pathRow(r) {
  return (
    r && {
      id: r.id,
      label: r.label,
      path: r.path,
      note: r.note || "",
      sortOrder: Number(r.sort_order || 0),
    }
  );
}
function taskRow(r) {
  if (!r) return null;
  const metadata = parseJson(r.metadata_json);
  return {
    id: r.id,
    projectId: r.project_id,
    title: r.title,
    description: r.description || "",
    status: r.status,
    priority: r.priority,
    assignedAgentId: r.assigned_agent_id || null,
    metadata,
    execution: parseJson(r.execution_json),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    terminalAt: metadata.terminalAt || null,
  };
}
function taskInput(input = {}, partial = false) {
  const r = {};
  if (!partial || input.title !== undefined) {
    r.title = text(input.title);
    if (!r.title || r.title.length > 240) throw new Error("task_title_invalid");
  }
  if (!partial || input.projectId !== undefined)
    r.projectId = id(input.projectId, "task_project_id");
  if (input.description !== undefined) {
    r.description = text(input.description);
    if (r.description.length > 20000)
      throw new Error("task_description_too_large");
  }
  if (input.status !== undefined) {
    r.status = text(input.status).toLowerCase();
    if (!STATUS_SET.has(r.status)) throw new Error("task_status_invalid");
  }
  if (input.priority !== undefined) {
    r.priority = text(input.priority).toLowerCase();
    if (!PRIORITY_SET.has(r.priority)) throw new Error("task_priority_invalid");
  }
  if (input.assignedAgentId !== undefined)
    r.assignedAgentId =
      input.assignedAgentId == null || input.assignedAgentId === ""
        ? null
        : id(input.assignedAgentId, "task_assigned_agent_id");
  if (input.metadata !== undefined) {
    if (
      !input.metadata ||
      typeof input.metadata !== "object" ||
      Array.isArray(input.metadata)
    )
      throw new Error("task_metadata_invalid");
    r.metadata = input.metadata;
  }
  return r;
}
function projectInput(input = {}, current = null) {
  const name = input.name === undefined ? current?.name : text(input.name);
  const description =
    input.description === undefined
      ? current?.description || ""
      : text(input.description);
  const notes =
    input.notes === undefined ? current?.notes || "" : text(input.notes);
  if (!name || name.length > 160) throw new Error("project_name_invalid");
  if (description.length > 20000)
    throw new Error("project_description_too_large");
  if (notes.length > 40000) throw new Error("project_notes_too_large");
  const entries =
    input.pathEntries === undefined
      ? current?.pathEntries || []
      : input.pathEntries;
  if (!Array.isArray(entries) || entries.length > 100)
    throw new Error("project_paths_invalid");
  return {
    name,
    description,
    notes,
    pathEntries: entries.map((e, i) => {
      const label = text(e?.label),
        path = text(e?.path),
        note = text(e?.note);
      if (
        !label ||
        label.length > 160 ||
        !path ||
        path.length > 4096 ||
        note.length > 4000
      )
        throw new Error("project_path_invalid");
      return {
        id: e?.id ? id(e.id, "project_path_id") : randomUUID(),
        label,
        path,
        note,
        sortOrder: Number.isInteger(e?.sortOrder) ? e.sortOrder : i,
      };
    }),
  };
}

export const POSTGRES_TASK_BOARD_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS task_board_projects (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS task_board_project_paths (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES task_board_projects(id) ON DELETE CASCADE, label TEXT NOT NULL, path TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS task_board_project_paths_order_idx ON task_board_project_paths(project_id,sort_order,id);
CREATE TABLE IF NOT EXISTS task_board_tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES task_board_projects(id) ON DELETE CASCADE, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL CHECK(status IN ('backlog','todo','in_progress','review','done','cancelled')), priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('critical','high','normal','low')), assigned_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL, metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb, execution_json JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS task_board_tasks_project_status_idx ON task_board_tasks(project_id,status,updated_at);
CREATE INDEX IF NOT EXISTS task_board_tasks_priority_idx ON task_board_tasks(priority,updated_at);
CREATE TABLE IF NOT EXISTS conversation_project_bindings (agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, session_id TEXT NOT NULL, project_id TEXT NOT NULL REFERENCES task_board_projects(id) ON DELETE CASCADE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(agent_id,session_id));`;
export const TASK_BOARD_SCHEMA_SQL = POSTGRES_TASK_BOARD_SCHEMA_SQL;

export class PostgresTaskBoardStore {
  constructor({ pool, ownsPool = false, clock = now } = {}) {
    if (!pool?.query || !pool?.connect)
      throw new Error("task_board_postgres_pool_required");
    this.pool = pool;
    this.ownsPool = ownsPool;
    this.clock = clock;
  }
  async close() {
    if (this.ownsPool) await closePostgresPool(this.pool);
  }
  async paths(client, projectId) {
    const r = await client.query(
      "SELECT * FROM task_board_project_paths WHERE project_id=$1 ORDER BY sort_order,id",
      [projectId],
    );
    return r.rows.map(pathRow);
  }
  async hydrate(client, row) {
    return row ? projectRow(row, await this.paths(client, row.id)) : null;
  }
  async getProject(projectId, client = this.pool) {
    const r = await client.query(
      "SELECT * FROM task_board_projects WHERE id=$1",
      [id(projectId, "project_id")],
    );
    return this.hydrate(client, r.rows[0]);
  }
  async listProjects() {
    const r = await this.pool.query(
      `SELECT * FROM task_board_projects ORDER BY translate(name, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz') COLLATE "C", id`,
    );
    return Promise.all(r.rows.map((x) => this.hydrate(this.pool, x)));
  }
  async replacePaths(client, projectId, entries, stamp) {
    await client.query(
      "DELETE FROM task_board_project_paths WHERE project_id=$1",
      [projectId],
    );
    for (const e of entries)
      await client.query(
        "INSERT INTO task_board_project_paths (id,project_id,label,path,note,sort_order,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$7)",
        [e.id, projectId, e.label, e.path, e.note, e.sortOrder, stamp],
      );
  }
  async createProject(input = {}) {
    const p = projectInput(input),
      stamp = this.clock(),
      projectId = input.id ? id(input.id, "project_id") : randomUUID();
    return withPostgresTransaction(this.pool, async (c) => {
      await c.query(
        "INSERT INTO task_board_projects (id,name,description,notes,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$5)",
        [projectId, p.name, p.description, p.notes, stamp],
      );
      await this.replacePaths(c, projectId, p.pathEntries, stamp);
      return this.getProject(projectId, c);
    });
  }
  async updateProject(projectId, input = {}) {
    return withPostgresTransaction(this.pool, async (c) => {
      const r = await c.query(
        "SELECT * FROM task_board_projects WHERE id=$1 FOR UPDATE",
        [id(projectId, "project_id")],
      );
      if (!r.rows[0]) return null;
      const current = await this.hydrate(c, r.rows[0]),
        p = projectInput(input, current),
        stamp = this.clock();
      await c.query(
        "UPDATE task_board_projects SET name=$1,description=$2,notes=$3,updated_at=$4 WHERE id=$5",
        [p.name, p.description, p.notes, stamp, current.id],
      );
      await this.replacePaths(c, current.id, p.pathEntries, stamp);
      return this.getProject(current.id, c);
    });
  }
  async deleteProject(projectId) {
    return withPostgresTransaction(this.pool, async (c) => {
      const r = await c.query(
        "SELECT * FROM task_board_projects WHERE id=$1 FOR UPDATE",
        [id(projectId, "project_id")],
      );
      if (!r.rows[0]) return null;
      const current = await this.hydrate(c, r.rows[0]);
      await c.query("DELETE FROM task_board_projects WHERE id=$1", [
        current.id,
      ]);
      return current;
    });
  }
  async getConversationProject({ agentId, sessionId = "default" } = {}) {
    const r = await this.pool.query(
      "SELECT p.* FROM conversation_project_bindings b JOIN task_board_projects p ON p.id=b.project_id WHERE b.agent_id=$1 AND b.session_id=$2",
      [id(agentId, "agent_id"), text(sessionId) || "default"],
    );
    return this.hydrate(this.pool, r.rows[0]);
  }
  async setConversationProject({
    agentId,
    sessionId = "default",
    projectId,
  } = {}) {
    return withPostgresTransaction(this.pool, async (c) => {
      const p = await this.getProject(projectId, c);
      if (!p) throw new Error("project_not_found");
      const stamp = this.clock();
      await c.query(
        "INSERT INTO conversation_project_bindings(agent_id,session_id,project_id,created_at,updated_at) VALUES($1,$2,$3,$4,$4) ON CONFLICT(agent_id,session_id) DO UPDATE SET project_id=EXCLUDED.project_id,updated_at=EXCLUDED.updated_at",
        [id(agentId, "agent_id"), text(sessionId) || "default", p.id, stamp],
      );
      return p;
    });
  }
  async clearConversationProject({ agentId, sessionId = "default" } = {}) {
    const r = await this.pool.query(
      "DELETE FROM conversation_project_bindings WHERE agent_id=$1 AND session_id=$2",
      [id(agentId, "agent_id"), text(sessionId) || "default"],
    );
    return r.rowCount > 0;
  }
  async listTasks({
    projectId = null,
    status = null,
    priority = null,
    assignedAgentId = null,
  } = {}) {
    const s = status && text(status).toLowerCase(),
      p = priority && text(priority).toLowerCase();
    if (s && !STATUS_SET.has(s)) throw new Error("task_status_invalid");
    if (p && !PRIORITY_SET.has(p)) throw new Error("task_priority_invalid");
    const r = await this.pool.query(
      "SELECT * FROM task_board_tasks WHERE ($1::text IS NULL OR project_id=$1) AND ($2::text IS NULL OR status=$2) AND ($3::text IS NULL OR priority=$3) AND ($4::text IS NULL OR assigned_agent_id=$4) ORDER BY CASE priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END,updated_at DESC,created_at DESC",
      [
        projectId || null,
        status ? s : null,
        priority ? p : null,
        assignedAgentId || null,
      ],
    );
    return r.rows.map(taskRow);
  }
  async getTask(taskId, client = this.pool) {
    const r = await client.query("SELECT * FROM task_board_tasks WHERE id=$1", [
      id(taskId, "task_id"),
    ]);
    return taskRow(r.rows[0]);
  }
  async createTask(input = {}) {
    const t = taskInput(input),
      stamp = this.clock(),
      taskId = input.id ? id(input.id, "task_id") : randomUUID();
    return withPostgresTransaction(this.pool, async (c) => {
      const p = await this.getProject(t.projectId, c);
      if (!p) throw new Error("task_project_not_found");
      const metadata = createdMetadata(
        t.metadata || {},
        input.actorAgentId ?? t.assignedAgentId ?? null,
        stamp,
      );
      await c.query(
        "INSERT INTO task_board_tasks(id,project_id,title,description,status,priority,assigned_agent_id,metadata_json,execution_json,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$10)",
        [
          taskId,
          t.projectId,
          t.title,
          t.description || "",
          t.status || "backlog",
          t.priority || "normal",
          t.assignedAgentId || null,
          json(metadata),
          json({}),
          stamp,
        ],
      );
      return this.getTask(taskId, c);
    });
  }
  async updateTask(taskId, input = {}) {
    return withPostgresTransaction(this.pool, async (c) => {
      const r = await c.query(
        "SELECT * FROM task_board_tasks WHERE id=$1 FOR UPDATE",
        [id(taskId, "task_id")],
      );
      if (!r.rows[0]) return null;
      const current = taskRow(r.rows[0]),
        t = taskInput(input, true);
      if (t.projectId && !(await this.getProject(t.projectId, c)))
        throw new Error("task_project_not_found");
      const stamp = this.clock(),
        status = t.status ?? current.status,
        metadata = { ...(t.metadata ?? current.metadata) };
      if (
        ["done", "cancelled"].includes(status) &&
        !["done", "cancelled"].includes(current.status)
      )
        metadata.terminalAt = stamp;
      const fields = [
        "projectId",
        "title",
        "description",
        "status",
        "priority",
        "assignedAgentId",
      ].filter(
        (f) =>
          t[f] !== undefined &&
          (f === "status" ? status !== current.status : t[f] !== current[f]),
      );
      if (t.metadata !== undefined) fields.push("metadata");
      const next = editedMetadata(current.metadata || {}, metadata, {
        actorAgentId: input.actorAgentId ?? null,
        at: stamp,
        fields,
      });
      await c.query(
        "UPDATE task_board_tasks SET project_id=$1,title=$2,description=$3,status=$4,priority=$5,assigned_agent_id=$6,metadata_json=$7::jsonb,updated_at=$8 WHERE id=$9",
        [
          t.projectId ?? current.projectId,
          t.title ?? current.title,
          t.description ?? current.description,
          status,
          t.priority ?? current.priority,
          t.assignedAgentId === undefined
            ? current.assignedAgentId
            : t.assignedAgentId,
          json(next),
          stamp,
          current.id,
        ],
      );
      return this.getTask(current.id, c);
    });
  }
  async deleteTask(taskId) {
    return withPostgresTransaction(this.pool, async (c) => {
      const r = await c.query(
        "SELECT * FROM task_board_tasks WHERE id=$1 FOR UPDATE",
        [id(taskId, "task_id")],
      );
      if (!r.rows[0]) return null;
      const current = taskRow(r.rows[0]);
      await c.query("DELETE FROM task_board_tasks WHERE id=$1", [current.id]);
      return current;
    });
  }
  async startExecution(taskId, execution = {}) {
    return withPostgresTransaction(this.pool, async (c) => {
      const current = await this.lockTask(c, taskId);
      if (!current) return null;
      const stamp = this.clock(),
        receipt = {
          taskId: current.id,
          agentId: text(execution.agentId) || current.assignedAgentId || null,
          sessionId: text(execution.sessionId) || "default",
          runId: text(execution.runId) || null,
          status: "running",
          dispatchedAt: stamp,
          traceDir: execution.traceDir || null,
          decision: null,
          ok: null,
          completedAt: null,
          error: null,
          result: null,
        };
      await c.query(
        "UPDATE task_board_tasks SET execution_json=$1::jsonb,updated_at=$2 WHERE id=$3",
        [json(receipt), stamp, current.id],
      );
      return this.getTask(current.id, c);
    });
  }
  async recordExecution(taskId, execution = {}) {
    return withPostgresTransaction(this.pool, async (c) => {
      const current = await this.lockTask(c, taskId);
      if (!current) return null;
      const stamp = this.clock(),
        receipt = {
          ...(current.execution || {}),
          taskId: current.id,
          agentId: text(execution.agentId) || current.assignedAgentId || null,
          sessionId: text(execution.sessionId) || "default",
          runId: text(execution.runId) || null,
          status: execution.status || (execution.ok ? "completed" : "failed"),
          executedAt: execution.executedAt || stamp,
          completedAt: stamp,
          traceDir: execution.traceDir || null,
          decision: execution.decision || null,
          ok: Boolean(execution.ok),
          error: execution.ok
            ? null
            : execution.error || "task_execution_failed",
          result:
            execution.result && typeof execution.result === "object"
              ? execution.result
              : null,
        };
      await c.query(
        "UPDATE task_board_tasks SET execution_json=$1::jsonb,updated_at=$2 WHERE id=$3",
        [json(receipt), stamp, current.id],
      );
      return this.getTask(current.id, c);
    });
  }
  async lockTask(c, taskId) {
    const r = await c.query(
      "SELECT * FROM task_board_tasks WHERE id=$1 FOR UPDATE",
      [id(taskId, "task_id")],
    );
    return taskRow(r.rows[0]);
  }
}
