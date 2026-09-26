import { promises as fs } from 'node:fs';
export function createForgeRoutes({ store, readJsonBody, sendJson }) {
  return async ({ req, res, url }) => {
    if (!url.pathname.startsWith('/api/forge/')) return false;
    try {
      const forge = store();
      if (req.method === 'GET' && url.pathname === '/api/forge/catalog') sendJson(res, 200, forge.catalog());
      else if (req.method === 'GET' && url.pathname === '/api/forge/jobs') sendJson(res, 200, { ok: true, jobs: await forge.list() });
      else if (req.method === 'POST' && url.pathname === '/api/forge/jobs') { const result = await forge.create(await readJsonBody(req)); sendJson(res, result.replayed ? 200 : 202, { ok: true, ...result }); }
      else {
        const match = url.pathname.match(/^\/api\/forge\/jobs\/([^/]+)(?:\/(attach|artifacts)(?:\/([^/]+))?)?$/);
        if (!match) { sendJson(res, 404, { ok: false, error: 'forge_job_not_found' }); return true; }
        const [, id, action, artifactId] = match;
        if (req.method === 'GET' && !action) { await forge.owner(); sendJson(res, 200, { ok: true, job: forge.public(forge.get(id)) }); }
        else if (req.method === 'POST' && action === 'attach') sendJson(res, 200, { ok: true, attachment: await forge.attach(id, await readJsonBody(req)) });
        else if (req.method === 'GET' && action === 'artifacts' && artifactId) { const { artifact, resolved } = await forge.artifact(id, artifactId); const bytes = await fs.readFile(resolved.filePath); res.writeHead(200, { 'content-type': artifact.mimeType, 'content-length': bytes.length, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', 'content-disposition': `${url.searchParams.get('download') === '1' ? 'attachment' : 'inline'}; filename="${artifact.name}"` }); res.end(bytes); }
        else sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
      }
    } catch (error) { sendJson(res, error.statusCode || 500, { ok: false, error: error.statusCode ? error.message : 'forge_unavailable' }); }
    return true;
  };
}
