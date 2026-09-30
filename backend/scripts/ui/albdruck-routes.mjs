/** Runs behind the same authentication boundary as the other settings routes. */
export function createAlbdruckRoutes({ store, readJsonBody, sendJson }) {
  return async ({ req, res, url }) => {
    if (!url.pathname.startsWith('/api/albdruck/')) return false;
    const options = { agentId: url.searchParams.get('agentId'), scope: url.searchParams.get('scope') || 'agent' };
    try {
      let result;
      if (url.pathname === '/api/albdruck/retention' && req.method === 'GET') result = await store.readRetention();
      else if (url.pathname === '/api/albdruck/retention' && req.method === 'PUT') result = await store.saveRetention(await readJsonBody(req));
      else if (url.pathname === '/api/albdruck/purge-conversation' && req.method === 'POST') result = await store.purgeConversation(await readJsonBody(req));
      else if (url.pathname === '/api/albdruck/history' && req.method === 'POST') result = await store.history({ ...await readJsonBody(req), ...options });
      else if (url.pathname === '/api/albdruck/recall' && req.method === 'POST') result = await store.recall({ ...await readJsonBody(req), ...options });
      else if (url.pathname === '/api/albdruck/knowledge' && req.method === 'GET') result = await store.list({ ...options, query: url.searchParams.get('query') || '', cursor: url.searchParams.get('cursor') || '', ...(url.searchParams.has('pageSize') ? { pageSize: Number(url.searchParams.get('pageSize')) } : {}) });
      else {
        const match = /^\/api\/albdruck\/knowledge\/([^/]+)$/.exec(url.pathname);
        if (!match) return false;
        const id = decodeURIComponent(match[1]);
        if (req.method === 'GET') result = await store.detail({ ...options, id });
        else if (req.method === 'PUT' || req.method === 'DELETE') {
          const body = await readJsonBody(req);
          result = await store.review({ ...body, ...options, id, operation: req.method === 'DELETE' ? 'delete' : body.operation || 'correct' });
        } else return false;
      }
      sendJson(res, result === null ? 404 : 200, result === null ? { error: 'albdruck_not_found' } : result);
    } catch (error) {
      if (!String(error.message).startsWith('albdruck_') && error.code !== '23505') throw error;
      sendJson(res, error.code === '23505' || (error.message.includes('inactive') || error.message.includes('active') || error.message.includes('current_main')) ? 409 : 400, { error: error.code === '23505' ? 'albdruck_identity_conflict' : error.message });
    }
    return true;
  };
}
