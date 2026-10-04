import path from 'node:path';

// Artifact bytes are private operator data, never immutable application assets.
export function artifactResponseHeaders({ name = 'artifact', mimeType = '', download = false } = {}) {
  const extension = path.extname(String(name)).toLowerCase();
  const type = String(mimeType).split(';')[0].trim().toLowerCase();
  const active = ['.html', '.htm', '.svg', '.xhtml'].includes(extension)
    || ['text/html', 'image/svg+xml', 'application/xhtml+xml'].includes(type);
  const filename = String(name).replace(/["\\\r\n\x00-\x1f\x7f]/g, '_');
  return {
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
    'content-disposition': `${download || active ? 'attachment' : 'inline'}; filename="${filename}"`,
    ...(active ? { 'content-security-policy': "sandbox; default-src 'none'" } : {}),
  };
}
