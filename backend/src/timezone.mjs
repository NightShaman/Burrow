export function validateTimezone(value = 'UTC', error = 'operator_timezone_invalid') {
  if (typeof value !== 'string' || !value.trim() || /^[+-]/.test(value)) throw new Error(error);
  try { return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone; }
  catch { throw new Error(error); }
}
export async function operatorTimezone(metadata) {
  const value = await metadata.get('operator_timezone');
  return validateTimezone(value?.timezone || 'UTC');
}
export async function saveOperatorTimezone(metadata, body) {
  let timezone;
  try { timezone = validateTimezone(body?.timezone); if (!body?.timezone) throw Error(); }
  catch { return { ok: false, status: 400, error: 'operator_timezone_invalid' }; }
  await metadata.set('operator_timezone', { timezone });
  return { ok: true, timezone };
}
export function localDay(timestamp, timezone = 'UTC') {
  const date = new Date(timestamp);
  if (!timestamp || !Number.isFinite(date.getTime())) return '';
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
export function localTimestamp(timestamp, timezone = 'UTC') {
  return new Intl.DateTimeFormat('en-GB', { timeZone: timezone, dateStyle: 'full', timeStyle: 'long', hourCycle: 'h23' }).format(new Date(timestamp));
}
