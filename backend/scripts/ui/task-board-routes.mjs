import { coreApiCaller } from '../../src/core-api-dispatch.mjs';
import { artifactResponseHeaders } from '../../src/artifact-response-policy.mjs';

function operatorAudit(req) { const actor = coreApiCaller(req); return actor ? { actor: { type: 'agent', id: actor.caller.agentId }, runId: actor.caller.runId, sessionId: actor.caller.sessionId } : { actor: { type: 'operator', id: 'default' } }; }
function statusCode(error) { return Number(error?.statusCode) || 400; }
function sendAttachment(res, attachment) {
  const bytes = Buffer.isBuffer(attachment.content) ? attachment.content : Buffer.from(attachment.content || '');
  res.writeHead(200, {
    'content-type': attachment.mimeType || 'application/octet-stream',
    'content-length': bytes.length,
    ...artifactResponseHeaders({ name: attachment.name, mimeType: attachment.mimeType, download: true }),
  });
  res.end(bytes);
}

export function createTaskBoardRoutes({ readJsonBody, sendJson, validateBoundaryBody, withTaskBoard, taskStatuses, taskPriorities, executeBoardTask } = {}) {
  return async function handleTaskBoardRoute({ req, res, url } = {}) {
    if (req.method === 'GET' && url.pathname === '/api/task-board/statuses') {
      sendJson(res, 200, { ok: true, statuses: taskStatuses }); return true;
    }
    if (req.method === 'GET' && url.pathname === '/api/task-board/priorities') {
      sendJson(res, 200, { ok: true, priorities: taskPriorities }); return true;
    }
    if (url.pathname === '/api/task-board/conversation-project') {
      if (req.method === 'GET') {
        const agentId = url.searchParams.get('agentId'), sessionId = url.searchParams.get('sessionId') || 'default';
        if (!agentId) sendJson(res, 400, { ok: false, error: 'agent_id_required' });
        else sendJson(res, 200, await withTaskBoard(async (store) => ({ ok: true, project: await store.getConversationProject({ agentId, sessionId }) })));
        return true;
      }
      if (req.method === 'PUT') {
        const body = await readJsonBody(req);
        if (!body.agentId) sendJson(res, 400, { ok: false, error: 'agent_id_required' });
        else if (!body.projectId) sendJson(res, 400, { ok: false, error: 'project_id_required' });
        else sendJson(res, 200, await withTaskBoard(async (store) => ({ ok: true, project: await store.setConversationProject({ agentId: body.agentId, sessionId: body.sessionId || 'default', projectId: body.projectId }) })));
        return true;
      }
      if (req.method === 'DELETE') {
        const agentId = url.searchParams.get('agentId'), sessionId = url.searchParams.get('sessionId') || 'default';
        if (!agentId) sendJson(res, 400, { ok: false, error: 'agent_id_required' });
        else { await withTaskBoard(async (store) => store.clearConversationProject({ agentId, sessionId })); sendJson(res, 200, { ok: true, project: null }); }
        return true;
      }
    }
    if (req.method === 'GET' && url.pathname === '/api/task-board/projects') {
      sendJson(res, 200, await withTaskBoard(async (store) => ({ ok: true, projects: await store.listProjects() }))); return true;
    }
    if (req.method === 'POST' && url.pathname === '/api/task-board/projects') {
      const body = validateBoundaryBody('project-create', await readJsonBody(req));
      sendJson(res, 201, await withTaskBoard(async (store) => ({ ok: true, project: await store.createProject(body) }))); return true;
    }
    if (url.pathname.startsWith('/api/task-board/projects/')) {
      const projectId = decodeURIComponent(url.pathname.slice('/api/task-board/projects/'.length));
      if (req.method === 'PATCH') {
        const project = await withTaskBoard(async (store) => store.updateProject(projectId, await readJsonBody(req)));
        sendJson(res, project ? 200 : 404, project ? { ok: true, project } : { ok: false, error: 'project_not_found' }); return true;
      }
      if (req.method === 'DELETE') {
        const project = await withTaskBoard(async (store) => store.deleteProject(projectId));
        sendJson(res, project ? 200 : 404, project ? { ok: true, project } : { ok: false, error: 'project_not_found' }); return true;
      }
    }
    if (req.method === 'GET' && url.pathname === '/api/task-board/tasks') {
      sendJson(res, 200, await withTaskBoard(async (store) => ({ ok: true, tasks: await store.listTasks({ projectId: url.searchParams.get('projectId'), status: url.searchParams.get('status'), priority: url.searchParams.get('priority'), assignedAgentId: url.searchParams.get('assignedAgentId') }) }))); return true;
    }
    if (req.method === 'POST' && url.pathname === '/api/task-board/tasks') {
      const body = validateBoundaryBody('task-create', await readJsonBody(req));
      sendJson(res, 201, await withTaskBoard(async (store) => ({ ok: true, task: await store.createTask(body, operatorAudit(req)) }))); return true;
    }
    if (url.pathname.startsWith('/api/task-board/tasks/')) {
      const parts = url.pathname.slice('/api/task-board/tasks/'.length).split('/').map(decodeURIComponent);
      const taskId = parts[0], action = parts[1] || null, attachmentId = action === 'attachments' ? parts[2] || null : null;
      if (req.method === 'POST' && action === 'execute') { sendJson(res, 200, await executeBoardTask(taskId)); return true; }
      if (action === 'history' && req.method === 'GET') {
        const page = await withTaskBoard((store) => store.taskHistory(taskId, { limit: url.searchParams.get('limit'), before: url.searchParams.get('before') }));
        sendJson(res, page ? 200 : 404, page ? { ok: true, ...page } : { ok: false, error: 'task_not_found' }); return true;
      }
      if (action === 'attachments') {
        if (req.method === 'GET' && !attachmentId) {
          const attachments = await withTaskBoard((store) => store.listAttachments(taskId));
          sendJson(res, attachments ? 200 : 404, attachments ? { ok: true, attachments } : { ok: false, error: 'task_not_found' }); return true;
        }
        if (req.method === 'POST' && !attachmentId) {
          try {
            const body = await readJsonBody(req);
            const attachment = await withTaskBoard((store) => store.addAttachment(taskId, body, operatorAudit(req)));
            sendJson(res, attachment ? 201 : 404, attachment ? { ok: true, attachment } : { ok: false, error: 'task_not_found' });
          } catch (error) { sendJson(res, statusCode(error), { ok: false, error: error?.message || 'task_attachment_failed' }); }
          return true;
        }
        if (req.method === 'GET' && attachmentId) {
          const attachment = await withTaskBoard((store) => store.getAttachment(taskId, attachmentId, { includeContent: true }));
          if (!attachment) sendJson(res, 404, { ok: false, error: 'task_attachment_not_found' }); else sendAttachment(res, attachment);
          return true;
        }
        if (req.method === 'DELETE' && attachmentId) {
          const attachment = await withTaskBoard((store) => store.deleteAttachment(taskId, attachmentId, operatorAudit(req)));
          const status = attachment === null ? 404 : attachment === false ? 404 : 200;
          sendJson(res, status, attachment ? { ok: true, attachment } : { ok: false, error: attachment === null ? 'task_not_found' : 'task_attachment_not_found' }); return true;
        }
      }
      if (req.method === 'PATCH' && !action) {
        const task = await withTaskBoard(async (store) => store.updateTask(taskId, await readJsonBody(req), operatorAudit(req)));
        sendJson(res, task ? 200 : 404, task ? { ok: true, task } : { ok: false, error: 'task_not_found' }); return true;
      }
      if (req.method === 'DELETE' && !action) {
        const task = await withTaskBoard(async (store) => store.deleteTask(taskId, operatorAudit(req)));
        sendJson(res, task ? 200 : 404, task ? { ok: true, task } : { ok: false, error: 'task_not_found' }); return true;
      }
      if (req.method === 'GET' && !action) {
        const task = await withTaskBoard(async (store) => store.getTask(taskId));
        sendJson(res, task ? 200 : 404, task ? { ok: true, task } : { ok: false, error: 'task_not_found' }); return true;
      }
    }
    return false;
  };
}
