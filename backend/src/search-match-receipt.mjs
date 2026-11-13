// Columns are one-based UTF-16 code-unit offsets, end columns exclusive.
// The producer finds the match once. Projections use its offsets, never rerun
// a query/regex against an already-windowed excerpt.
export function compactSearchMatch(item = {}, limit = 500) {
  const sourceText = String(item?.text ?? '');
  const sourceStart = Number.isInteger(item.textStartColumn) ? item.textStartColumn : 1;
  const column = Number.isInteger(item.column) ? item.column : null;
  const matchLength = Number.isInteger(item.matchLength) ? item.matchLength : null;
  const relative = column === null ? 0 : Math.max(0, column - sourceStart);
  const width = Math.min(sourceText.length, Math.max(1, limit));
  const matchWidth = Math.min(matchLength ?? 0, width);
  const start = Math.max(0, Math.min(sourceText.length - width, relative - Math.floor((width - matchWidth) / 2)));
  const text = sourceText.slice(start, start + width);
  const originalCount = item.textDelivery?.originalCount ?? sourceText.length;
  const textStartColumn = sourceStart + start;
  const lineLength = item.lineLength ?? sourceText.length;
  return {
    filePath: item.filePath || null, line: item.line ?? null, text,
    ...(column !== null ? { column } : {}),
    ...(matchLength !== null ? { matchLength } : {}),
    textStartColumn, textEndColumn: textStartColumn + text.length, lineLength,
    textTruncated: Boolean(item.textTruncated) || textStartColumn > 1 || text.length < lineLength,
    textDelivery: { unit: 'chars', originalCount, deliveredCount: text.length, omittedCount: Math.max(0, originalCount - text.length) },
  };
}
