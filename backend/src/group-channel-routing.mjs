function normalized(value = '') {
  return String(value || '').trim().toLowerCase();
}

export function extractGroupMentions(message = '', participants = []) {
  const mentions = [];
  const seen = new Set();
  const text = String(message || '');
  const names = (participants || []).flatMap((item) => [item.name, item.id])
    .filter(Boolean).map(String).sort((a, b) => b.length - a.length);
  const pattern = /@([^\s@]+)/g;
  let match;
  while ((match = pattern.exec(text))) {
    const start = match.index + 1;
    // Prefer the longest actual participant name. A shorter name must not
    // capture the beginning of a multi-word or apostrophized name.
    const name = names.find((candidate) =>
      text.slice(start, start + candidate.length).toLowerCase() === candidate.toLowerCase()
      && !/[\p{L}\p{N}_.'’-]/u.test(text[start + candidate.length] || '')
      && !(text[start + candidate.length] === ' ' && /[\p{L}\p{N}]/u.test(text[start + candidate.length + 1] || '')
        && names.some((other) => other.toLowerCase().startsWith(`${candidate.toLowerCase()} `))));
    const value = (name && text.slice(start, start + name.length)) || match[1].replace(/[,!?;:]+$/, '');
    const key = normalized(value);
    if (key && !seen.has(key)) {
      seen.add(key);
      mentions.push(value);
    }
    if (name) pattern.lastIndex = start + name.length;
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
