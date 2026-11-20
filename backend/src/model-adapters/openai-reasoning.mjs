// Request-local Responses continuation state, not assistant prose or a raw
// provider output graph. Position is the number of function calls preceding
// this item in its output round, so parallel calls need not be regrouped.
export function responseReasoningItem(item) {
  if (item?.type !== 'reasoning' || typeof item.id !== 'string' || !item.id ||
      typeof item.encrypted_content !== 'string' || !item.encrypted_content) return null;
  return { type: 'reasoning', id: item.id, summary: [], encrypted_content: item.encrypted_content };
}

export function isResponsesReasoning(value) {
  return value && typeof value.owner === 'string' && value.owner &&
    Object.keys(value).every(key => ['owner', 'items'].includes(key)) &&
    Array.isArray(value.items) && value.items.length > 0 && value.items.every((item, index, items) =>
      item && Object.keys(item).every(key => ['position', 'id', 'encrypted_content'].includes(key)) &&
      Number.isSafeInteger(item.position) && item.position >= 0 && (!index || item.position >= items[index - 1].position) &&
      typeof item.id === 'string' && item.id && typeof item.encrypted_content === 'string' && item.encrypted_content);
}

export function responseReasoningMessage(output, owner, assistant) {
  let position = 0;
  const items = [];
  for (const item of Array.isArray(output) ? output : []) {
    if (item?.type === 'function_call' || item?.type === 'tool_call') position++;
    const reasoning = responseReasoningItem(item);
    if (reasoning) items.push({ position, id: reasoning.id, encrypted_content: reasoning.encrypted_content });
  }
  return items.length ? { ...assistant, responsesReasoning: { owner, items } } : null;
}
