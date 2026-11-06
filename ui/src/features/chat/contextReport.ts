/** Command-owned presentation, never parsed from model-authored Markdown. */
export type ContextReport = {
  version: 1;
  blocks: Array<{ title: string; markdown: string; collapsed?: boolean }>;
};

export function contextReport(value: unknown): ContextReport | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const report = value as Record<string, unknown>;
  if (report.version !== 1 || !Array.isArray(report.blocks) || !report.blocks.length)
    return undefined;
  const blocks: ContextReport['blocks'] = [];
  for (const value of report.blocks) {
    if (!value || typeof value !== 'object') return undefined;
    const block = value as Record<string, unknown>;
    if (
      typeof block.title !== 'string' ||
      typeof block.markdown !== 'string' ||
      (block.collapsed !== undefined && typeof block.collapsed !== 'boolean')
    )
      return undefined;
    blocks.push({
      title: block.title,
      markdown: block.markdown,
      ...(block.collapsed !== undefined ? { collapsed: block.collapsed } : {}),
    });
  }
  return { version: 1, blocks };
}

/** Both JSON and NDJSON command responses may wrap the result. */
export function contextReportFromResult(value: unknown): ContextReport | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const root = value as Record<string, unknown>;
  const result = root.result;
  if (result && typeof result === 'object' && 'contextReport' in result)
    return contextReport(result.contextReport);
  return contextReport(root.contextReport);
}
