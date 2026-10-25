export type HttpHeaderRow = { rowId: number; name: string; value: string; configured: boolean; replacing: boolean };

export function serializeHttpHeaders(rows: HttpHeaderRow[]): Record<string, string | null> {
  return Object.fromEntries(rows.filter(row => row.name.trim() || row.value).map(row => [row.name.trim(), row.configured && !row.replacing ? null : row.value]));
}

export function validateHttpHeaders(rows: HttpHeaderRow[]): string | null {
  const names = new Set<string>();
  for (const row of rows) {
    if (!row.name.trim() && !row.value) continue;
    const name = row.name.trim();
    if (name.length > 128 || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) return 'Enter a valid HTTP header name.';
    if (names.has(name.toLowerCase())) return `Duplicate HTTP header: ${name}.`;
    names.add(name.toLowerCase());
    if (names.size > 64) return 'Use no more than 64 HTTP headers.';
    if (new TextEncoder().encode(row.value).length > 8192) return `The value for ${name} cannot exceed 8192 bytes.`;
    if (/[\r\n\0]/.test(row.value)) return `The value for ${name} cannot contain line breaks or null characters.`;
  }
  return null;
}

export function McpHttpHeaders({ rows, onChange, onAdd, disabled }: { rows: HttpHeaderRow[]; onChange: (rows: HttpHeaderRow[]) => void; onAdd: () => void; disabled: boolean }) {
  const update = (index: number, patch: Partial<HttpHeaderRow>) => onChange(rows.map((row, i) => i === index ? { ...row, ...patch } : row));
  return <div className="mcp-environment mcp-http-headers">
    <div className="mcp-environment-heading"><strong>HTTP headers</strong><button className="secondary" type="button" disabled={disabled} onClick={onAdd}>Add header</button></div>
    {rows.map((row, index) => <div className="mcp-http-header-row" key={row.rowId}>
      <input aria-label={`HTTP header ${index + 1} name`} placeholder="Header name" value={row.name} readOnly={row.configured} disabled={disabled} onChange={event => update(index, { name: event.target.value })} autoComplete="off" spellCheck={false} />
      <input aria-label={`HTTP header ${index + 1} value`} type="password" placeholder={row.configured && !row.replacing ? '••••••••' : 'Secret value'} value={row.value} readOnly={row.configured && !row.replacing} disabled={disabled} onChange={event => update(index, { value: event.target.value })} autoComplete="new-password" />
      <div className="mcp-http-header-actions">{row.configured && <button className="secondary" type="button" disabled={disabled} aria-label={`${row.replacing ? 'Cancel replacement of' : 'Replace'} ${row.name}`} onClick={() => update(index, { replacing: !row.replacing, value: '' })}>{row.replacing ? 'Cancel' : 'Replace'}</button>}
        <button className="memory-delete" type="button" disabled={disabled} onClick={() => onChange(rows.filter((_, i) => i !== index))} aria-label={`Remove ${row.name || 'HTTP header'}`} title="Remove">×</button></div>
    </div>)}
  </div>;
}
