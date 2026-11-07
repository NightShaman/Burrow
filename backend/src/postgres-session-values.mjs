const text = (value) => String(value ?? '');
const required = (value, name) => { const result = text(value).trim(); if (!result) throw new Error(`${name} is required`); return result; };

const cursorValue = (value, name = 'after') => {
  if (value === undefined || value === null || value === '') return 0n;
  const result = typeof value === 'bigint' ? value : (typeof value === 'number' && Number.isSafeInteger(value) ? BigInt(value) : (typeof value === 'string' && /^[0-9]+$/.test(value) ? BigInt(value) : null));
  if (result === null || result < 0n) throw new Error(`${name} must be a non-negative integer cursor`);
  return result;
};
const limitValue = (value) => {
  if (value === undefined || value === null || value === '') return 20;
  if ((typeof value === 'number' && Number.isInteger(value) && value > 0) || (typeof value === 'string' && /^[1-9][0-9]*$/.test(value))) return Number(value);
  throw new Error('limit must be a positive integer');
};
function rowEntry(row) { return row ? { ...row.entry, sequence: String(row.sequence) } : null; }
function proofRunKey(entry = {}) {
  const runId = typeof entry?.runId === 'string' ? entry.runId : '';
  return runId ? Buffer.from(JSON.stringify(runId), 'utf8').toString('hex') : null;
}


export { text, required, cursorValue, limitValue, rowEntry, proofRunKey };
