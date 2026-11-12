const tokenCharacter = /[\p{L}\p{M}\p{N}_.'’\-]/u;
const whitespace = /\s/u;

/** Same-length mask keeps source offsets stable; Markdown code and escapes are literal. */
export function mentionText(message) {
  const masked = message.split('');
  let fence = null;
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


function normalized(value = '') {
  return String(value || '').trim().toLowerCase();
}

export function extractGroupMentions(message = '', participants = []) {
  const mentions = [];
  const seen = new Set();
  const text = String(message || '');
  const visible = mentionText(text);
  const names = (participants || []).flatMap((item) => [item.name, item.id])
    .filter(Boolean).map(String).sort((a, b) => b.length - a.length);
  for (let index = 0; index < visible.length; index += 1) {
    if (visible[index] !== '@' || (index > 0 && !whitespace.test(text[index - 1]))) continue;
    const start = index + 1;
    const name = names.find(candidate =>
      visible.slice(start, start + candidate.length).toLowerCase() === candidate.toLowerCase()
      && !tokenCharacter.test(text[start + candidate.length] || ''));
    let end = start;
    if (name) end += name.length;
    else while (end < visible.length && tokenCharacter.test(visible[end])) end += 1;
    const value = name ? text.slice(start, end) : text.slice(start, end).replace(/[,!?;:]+$/, '');
    const key = normalized(value);
    if (key && !seen.has(key)) { seen.add(key); mentions.push(value); }
    index = Math.max(index, end - 1);
  }
  return mentions;
}

export function resolveGroupMentionTargets({ message = '', participants = [] } = {}) {
  const mentions = extractGroupMentions(message, participants);
  const targets = [];
  const unknown = [];
  const seen = new Set();
  for (const mention of mentions) {
    const key = normalized(mention);
    const participant = (participants || []).find((item) => normalized(item.id) === key || normalized(item.name) === key);
    if (!participant) {
      unknown.push(mention);
      continue;
    }
    if (!seen.has(participant.id)) {
      seen.add(participant.id);
      targets.push(participant.id);
    }
  }
  return { mentions, targets, unknown };
}
