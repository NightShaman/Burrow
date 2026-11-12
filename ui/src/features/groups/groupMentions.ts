/** Fallback mention syntax, shared with the backend group-channel-routing contract. */
const tokenCharacter = /[\p{L}\p{M}\p{N}_.'’\-]/u;
const whitespace = /\s/u;

/** Same-length mask keeps source offsets stable; Markdown code and escapes are literal. */
export function mentionText(message: string): string {
  const masked = message.split('');
  let fence: { character: string; length: number } | null = null;
  let inline = 0;
  let lineStart = true;
  for (let index = 0; index < message.length; ) {
    if (lineStart && !inline) {
      const marker = /^( {0,3})(`{3,}|~{3,})/.exec(message.slice(index));
      if (
        marker &&
        (!fence || (marker[2][0] === fence.character && marker[2].length >= fence.length))
      ) {
        const end = message.indexOf('\n', index);
        const stop = end < 0 ? message.length : end;
        // A closing fence may only be followed by whitespace.
        const closing = fence && !message.slice(index + marker[0].length, stop).trim();
        if (!fence || closing) {
          masked.fill(' ', index, stop);
          fence = fence ? null : { character: marker[2][0], length: marker[2].length };
          index = stop;
          lineStart = false;
          continue;
        }
      }
    }
    const character = message[index];
    if (character === '\n') {
      lineStart = true;
      index += 1;
      continue;
    }
    lineStart = false;
    if (fence) {
      masked[index++] = ' ';
      continue;
    }
    if (character === '\\' && !inline) {
      masked[index++] = ' ';
      if (index < message.length) masked[index++] = ' ';
      continue;
    }
    if (character === '`') {
      let end = index + 1;
      while (message[end] === '`') end += 1;
      const length = end - index;
      if (!inline) inline = length;
      else if (inline === length) inline = 0;
      masked.fill(' ', index, end);
      index = end;
      continue;
    }
    if (inline) masked[index] = ' ';
    index += 1;
  }
  return masked.join('');
}

export function getMentionMatch(value: string) {
  const match = mentionText(value).match(/(^|\s)@([\p{L}\p{M}\p{N}_.'’\-]*)$/u);
  if (!match) return null;
  const start = value.length - match[2].length - 1;
  return start === 0 || whitespace.test(value[start - 1]) ? match : null;
}

type Participant = { id: string; name: string };
export function groupMentionIds(message: string, participants: Participant[]): string[] {
  const visible = mentionText(message);
  const names = participants
    .flatMap((participant) =>
      [participant.name, participant.id]
        .filter(Boolean)
        .map((name) => ({ name, id: participant.id })),
    )
    .sort((a, b) => b.name.length - a.name.length);
  const ids = new Set<string>();
  for (let index = 0; index < visible.length; index += 1) {
    if (visible[index] !== '@' || (index > 0 && !whitespace.test(message[index - 1]))) continue;
    const start = index + 1;
    const match = names.find(
      ({ name }) =>
        visible.slice(start, start + name.length).toLowerCase() === name.toLowerCase() &&
        !tokenCharacter.test(message[start + name.length] || ''),
    );
    if (match) {
      ids.add(match.id);
      index = start + match.name.length - 1;
    }
  }
  return [...ids];
}
