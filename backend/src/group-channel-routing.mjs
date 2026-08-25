function normalized(value = '') {
  return String(value || '').trim().toLowerCase();
}

export function extractGroupMentions(message = '') {
  const mentions = [];
  const seen = new Set();
  const pattern = /@([a-zA-Z0-9._-]{1,96})/g;
  let match;
  while ((match = pattern.exec(String(message || '')))) {
    const value = match[1];
    const key = normalized(value);
    if (!seen.has(key)) {
      seen.add(key);
      mentions.push(value);
    }
  }
  return mentions;
}

export function resolveGroupMentionTargets({ message = '', participants = [] } = {}) {
  const mentions = extractGroupMentions(message);
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
