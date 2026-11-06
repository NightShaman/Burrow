import { expect, it } from 'vitest';
import { contextReport, contextReportFromResult } from './contextReport';

const report = { version: 1, blocks: [{ title: '', markdown: '# Context' }] };
it('accepts empty header titles and strips unknown fields without reordering blocks', () => {
  expect(contextReport({ ...report, unexpected: true })).toEqual(report);
  expect(contextReportFromResult({ result: { contextReport: report } })).toEqual(report);
  expect(contextReportFromResult({ contextReport: report })).toEqual(report);
});
it.each([
  null,
  'markdown',
  {},
  { ...report, version: 2 },
  { version: 1, blocks: [] },
  { version: 1, blocks: [null] },
  { version: 1, blocks: [{ title: 2, markdown: 'body' }] },
  { version: 1, blocks: [{ title: 'Title', markdown: {} }] },
  { version: 1, blocks: [{ title: '', markdown: 'body', collapsed: 'false' }] },
])('rejects malformed reports instead of partially replacing the fallback: %j', (value) => {
  expect(contextReport(value)).toBeUndefined();
});
