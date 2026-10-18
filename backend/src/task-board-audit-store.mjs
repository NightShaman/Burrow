import { createHash, randomUUID } from 'node:crypto';

const text = (value) => String(value ?? '').trim();
const id = (value, field) => {
  const normalized = text(value);
  if (!/^[A-Za-z0-9._-]{1,96}$/.test(normalized)) throw new Error(`${field}_invalid`);
  return normalized;
};
const json = (value) => JSON.stringify(value ?? {});
const parseJson = (value) => {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value || '{}'); } catch { return {}; }
};
const actorTypes = new Set(['operator', 'agent', 'system', 'unknown']);
const actor = (value = {}) => {
  const type = actorTypes.has(text(value?.type)) ? text(value.type) : 'unknown';
  return { type, id: text(value?.id) || null };
};
const attachmentMaxBytes = () => {
  const value = Number(process.env.BURROW_TASK_ATTACHMENT_MAX_BYTES ?? 25 * 1024 * 1024);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('task_attachment_max_bytes_invalid');
  return value;
};
const historyPageMax = () => {
  const value = Number(process.env.BURROW_TASK_HISTORY_PAGE_MAX ?? 500);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('task_history_page_max_invalid');
  return value;
};
const safeName = (value) => {
  const name = text(value).replace(/[\\/\u0000-\u001f\u007f]+/g, '-').slice(0, 240);
  if (!name) throw new Error('task_attachment_name_required');
  return name;
};
const bytesFromDataUrl = (content) => {
  const value = String(content ?? '');
  if (!value.startsWith('data:')) throw new Error('task_attachment_data_url_required');
  const comma = value.indexOf(',');
  if (comma < 0) throw new Error('task_attachment_data_url_invalid');
  try {
    const header = value.slice(5, comma).toLowerCase();
    const payload = value.slice(comma + 1);
    return header.includes(';base64') ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload), 'utf8');
  } catch { throw new Error('task_attachment_data_url_invalid'); }
};
const cursorFor = (row) => Buffer.from(JSON.stringify([
  row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  row.id,
])).toString('base64url');
const parseCursor = (value) => {
  if (!value) return null;
  try {
    const decoded = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
    if (!Array.isArray(decoded) || decoded.length !== 2 || !decoded.every((part) => typeof part === 'string' && part)) throw new Error();
    return decoded;
  } catch { throw new Error('task_history_cursor_invalid'); }
};
const eventRow = (row) => row && ({
  id: row.id,
  taskId: row.task_id,
  action: row.action,
  actor: { type: row.actor_type || 'unknown', id: row.actor_id || null, name: row.actor_name || null },
  at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  changes: parseJson(row.changes_json),
  details: parseJson(row.details_json),
  sessionId: row.session_id || null,
  runId: row.run_id || null,
});
const attachmentRow = (row) => row && ({
  id: row.id,
  taskId: row.task_id,
  name: row.name,
  mimeType: row.mime_type,
  size: Number(row.size_bytes),
  sha256: row.sha256,
  createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  createdBy: { type: row.actor_type || 'unknown', id: row.actor_id || null, name: row.actor_name || null },
});

export class TaskBoardAuditStore {
  constructor({ pool, clock = () => new Date().toISOString() } = {}) {
    if (!pool?.query) throw new Error('task_board_audit_pool_required');
    this.pool = pool;
    this.clock = clock;
  }
  async actorSnapshot(client, value = {}) {
    const normalized = actor(value);
    if (normalized.type === 'operator') {
      const result = await client.query("SELECT name FROM chat_identities WHERE kind='operator' AND id='default'");
      return { type: 'operator', id: normalized.id || 'default', name: text(result.rows[0]?.name) || null };
    }
    if (normalized.type === 'agent' && normalized.id) {
      const result = await client.query("SELECT COALESCE(NULLIF(i.name,''),a.name) AS name FROM (SELECT $1::text AS id) x LEFT JOIN chat_identities i ON i.kind='agent' AND i.id=x.id LEFT JOIN agents a ON a.id=x.id", [normalized.id]);
      return { type: 'agent', id: normalized.id, name: text(result.rows[0]?.name) || null };
    }
    if (normalized.type === 'system') return { type: 'system', id: normalized.id, name: 'Core' };
    return { type: 'unknown', id: null, name: null };
  }
  async append(client, taskId, action, { actor: requestedActor = {}, at = this.clock(), changes = {}, details = {}, sessionId = null, runId = null, eventId = null } = {}) {
    const who = await this.actorSnapshot(client, requestedActor);
    const event = { id: eventId || randomUUID(), taskId: id(taskId, 'task_id'), action: text(action), actor: who, at, changes, details, sessionId: text(sessionId) || null, runId: text(runId) || null };
    if (!event.action || event.action.length > 96) throw new Error('task_event_action_invalid');
    await client.query(`INSERT INTO task_board_task_events(id,task_id,action,actor_type,actor_id,actor_name,changes_json,details_json,session_id,run_id,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11)`, [event.id, event.taskId, event.action, who.type, who.id, who.name, json(changes), json(details), event.sessionId, event.runId, at]);
    return event;
  }
  async history(taskId, { limit = 100, before = null } = {}) {
    const task = await this.pool.query('SELECT id FROM task_board_tasks WHERE id=$1', [id(taskId, 'task_id')]);
    if (!task.rows[0]) return null;
    const bounded = Math.max(1, Math.min(historyPageMax(), Number(limit) || 100));
    const cursor = parseCursor(before);
    const params = [task.rows[0].id];
    let predicate = '';
    if (cursor) { params.push(cursor[0], cursor[1]); predicate = ' AND (created_at,id) < ($2::timestamptz,$3::text)'; }
    params.push(bounded + 1);
    const result = await this.pool.query(`SELECT * FROM task_board_task_events WHERE task_id=$1${predicate} ORDER BY created_at DESC,id DESC LIMIT $${params.length}`, params);
    const rows = result.rows.slice(0, bounded);
    return { events: rows.map(eventRow), hasMore: result.rows.length > bounded, nextCursor: result.rows.length > bounded && rows.length ? cursorFor(rows.at(-1)) : null };
  }
  async listAttachments(taskId) {
    const task = await this.pool.query('SELECT id FROM task_board_tasks WHERE id=$1', [id(taskId, 'task_id')]);
    if (!task.rows[0]) return null;
    const result = await this.pool.query('SELECT * FROM task_board_task_attachments WHERE task_id=$1 ORDER BY created_at,id', [task.rows[0].id]);
    return result.rows.map(attachmentRow);
  }
  async attachment(taskId, attachmentId, { includeContent = false, client = this.pool } = {}) {
    const result = await client.query('SELECT * FROM task_board_task_attachments WHERE task_id=$1 AND id=$2', [id(taskId, 'task_id'), id(attachmentId, 'task_attachment_id')]);
    return result.rows[0] ? { ...attachmentRow(result.rows[0]), ...(includeContent ? { content: result.rows[0].content } : {}) } : null;
  }
  async addAttachment(taskId, input = {}, audit = {}) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const task = await client.query('SELECT id FROM task_board_tasks WHERE id=$1 FOR UPDATE', [id(taskId, 'task_id')]);
      if (!task.rows[0]) { await client.query('ROLLBACK'); return null; }
      const name = safeName(input.name), mimeType = text(input.mimeType || input.type) || 'application/octet-stream';
      if (mimeType.length > 255) throw new Error('task_attachment_mime_type_invalid');
      const content = bytesFromDataUrl(input.content);
      if (content.length > attachmentMaxBytes()) throw Object.assign(new Error('task_attachment_too_large'), { statusCode: 413 });
      const at = this.clock(), attachmentId = randomUUID(), sha256 = createHash('sha256').update(content).digest('hex'), who = await this.actorSnapshot(client, audit.actor);
      await client.query(`INSERT INTO task_board_task_attachments(id,task_id,name,mime_type,size_bytes,sha256,content,actor_type,actor_id,actor_name,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [attachmentId, task.rows[0].id, name, mimeType, content.length, sha256, content, who.type, who.id, who.name, at]);
      await this.append(client, task.rows[0].id, 'attachment_added', { ...audit, actor: who, at, details: { attachmentId, name, mimeType, size: content.length, sha256 } });
      const attachment = await this.attachment(task.rows[0].id, attachmentId, { client });
      await client.query('COMMIT');
      return attachment;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async removeAttachment(taskId, attachmentId, audit = {}) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const task = await client.query('SELECT id FROM task_board_tasks WHERE id=$1 FOR UPDATE', [id(taskId, 'task_id')]);
      if (!task.rows[0]) { await client.query('ROLLBACK'); return null; }
      const result = await client.query('SELECT * FROM task_board_task_attachments WHERE task_id=$1 AND id=$2 FOR UPDATE', [task.rows[0].id, id(attachmentId, 'task_attachment_id')]);
      if (!result.rows[0]) { await client.query('ROLLBACK'); return false; }
      const attachment = attachmentRow(result.rows[0]), at = this.clock();
      await client.query('DELETE FROM task_board_task_attachments WHERE task_id=$1 AND id=$2', [task.rows[0].id, attachment.id]);
      await this.append(client, task.rows[0].id, 'attachment_removed', { ...audit, at, details: { attachmentId: attachment.id, name: attachment.name, mimeType: attachment.mimeType, size: attachment.size, sha256: attachment.sha256 } });
      await client.query('COMMIT');
      return attachment;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
}
