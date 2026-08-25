export function createExportRoutes({ readJsonBody, sendJson, exportCatalog, normalizeImportRequest, decodeExport, buildExport, exportSnapshot, importPreview, applyImport } = {}) {
  return async function handleExportRoute({ req, res, url } = {}) {
    if (req.method === 'GET' && url.pathname === '/api/export/catalog') {
      sendJson(res, 200, { ok: true, ...exportCatalog() });
      return true;
    }
    if (req.method === 'POST' && url.pathname === '/api/export') {
      const request = await readJsonBody(req);
      const result = await buildExport({ request, data: await exportSnapshot(Array.isArray(request?.categories) ? request.categories : []) });
      res.writeHead(200, {
        'content-type': result.contentType,
        'content-disposition': `attachment; filename="burrow-export.${result.extension}"`,
        'cache-control': 'no-store',
        'content-length': result.body.byteLength,
      });
      res.end(result.body);
      return true;
    }
    if (req.method === 'POST' && (url.pathname === '/api/export/import/preview' || url.pathname === '/api/export/import')) {
      const request = normalizeImportRequest(await readJsonBody(req));
      const decoded = await decodeExport(request.binary, { password: request.password });
      const preview = importPreview(decoded, request.conflictPolicy);
      if (url.pathname.endsWith('/preview')) {
        sendJson(res, 200, preview);
        return true;
      }
      if (!request.confirm) {
        sendJson(res, 400, { ok: false, error: 'import_confirmation_required', preview });
        return true;
      }
      const result = await applyImport(decoded, request);
      sendJson(res, result.status || 200, result);
      return true;
    }
    return false;
  };
}
