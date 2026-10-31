export const TIMEZONE = 'America/Chicago';

const localDateTime = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;
const explicitOffsetDateTime = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?)(Z|[+-]\d{2}:\d{2})$/;
type LocalDateTime = { year: number; month: number; day: number; hour: number; minute: number; second: number; millisecond: number };
const chicagoDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', numberingSystem: 'latn',
});

function localEpoch(value: LocalDateTime) {
  const date = new Date(0);
  date.setUTCFullYear(value.year, value.month - 1, value.day);
  date.setUTCHours(value.hour, value.minute, value.second, value.millisecond);
  return date.getTime();
}
function parseLocalDateTime(value: string): LocalDateTime | null {
  const match = value.match(localDateTime);
  if (!match) return null;
  const parsed = {
    year: Number(match[1]), month: Number(match[2]), day: Number(match[3]), hour: Number(match[4]), minute: Number(match[5]),
    second: Number(match[6] ?? 0), millisecond: Number((match[7] ?? '').padEnd(3, '0')),
  };
  const instant = new Date(localEpoch(parsed));
  return instant.getUTCFullYear() === parsed.year && instant.getUTCMonth() === parsed.month - 1 && instant.getUTCDate() === parsed.day
    && instant.getUTCHours() === parsed.hour && instant.getUTCMinutes() === parsed.minute && instant.getUTCSeconds() === parsed.second
    && instant.getUTCMilliseconds() === parsed.millisecond ? parsed : null;
}
function chicagoParts(epoch: number): LocalDateTime {
  const parts = chicagoDateFormatter.formatToParts(new Date(epoch));
  const value = (type: string) => Number(parts.find(part => part.type === type)?.value);
  const hour = value('hour');
  return { year: value('year'), month: value('month'), day: value('day'), hour: hour === 24 ? 0 : hour, minute: value('minute'), second: value('second'), millisecond: new Date(epoch).getUTCMilliseconds() };
}
function sameLocalDateTime(left: LocalDateTime, right: LocalDateTime) {
  return left.year === right.year && left.month === right.month && left.day === right.day && left.hour === right.hour
    && left.minute === right.minute && left.second === right.second && left.millisecond === right.millisecond;
}
function chicagoOffsetAt(epoch: number) { return localEpoch(chicagoParts(epoch)) - epoch; }
export function normalizeRunAt(value: unknown): string {
  if (typeof value !== 'string') throw new Error('runAt is required for a one-time job');
  const offset = value.match(explicitOffsetDateTime);
  if (offset) {
    const datePart = offset[1];
    const localPart = parseLocalDateTime(datePart);
    if (!localPart || Number.isNaN(Date.parse(value))) throw new Error('runAt must be a valid ISO datetime');
    // Saved ISO instants retain their explicit offset rather than being reinterpreted in the browser or fixture zone.
    return value;
  }
  const local = parseLocalDateTime(value);
  if (!local) throw new Error('runAt must be an ISO datetime or offsetless datetime-local value');
  const wallClockEpoch = localEpoch(local);
  // A local wall time can map to one (ordinary), two (fall-back), or zero
  // (spring-forward) instants. Pick the earlier valid fall-back instant and
  // reject a nonexistent clock time rather than silently changing it.
  const offsets = new Set<number>();
  for (let hour = -36; hour <= 36; hour += 1) offsets.add(chicagoOffsetAt(wallClockEpoch + hour * 60 * 60 * 1000));
  const matches = [...offsets].map(offsetMinutes => wallClockEpoch - offsetMinutes).filter(epoch => sameLocalDateTime(chicagoParts(epoch), local));
  if (!matches.length) throw new Error(`runAt is not a valid ${TIMEZONE} local time`);
  return new Date(Math.min(...matches)).toISOString();
}
type TaskSelection = { jobKind: 'prompt' | 'task'; taskId: string | null };
type Task = { id: string; status: string; assignedAgentId: string | null; archived?: boolean };
export function taskSelectionProblem(saved: TaskSelection, previous: TaskSelection | undefined, tasks: Task[], agentId: string): string {
  if (saved.jobKind !== 'task' || (previous?.jobKind === 'task' && previous.taskId === saved.taskId)) return '';
  const task = tasks.find(item => item.id === saved.taskId);
  if (!task) return 'Task no longer exists';
  if (task.archived) return 'Task is archived';
  if (task.assignedAgentId !== agentId) return task.assignedAgentId ? 'Task is assigned to another agent' : 'Task is unassigned';
  return task.status === 'todo' ? '' : 'Task is not in To Do';
}
