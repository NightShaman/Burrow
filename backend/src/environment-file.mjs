// Nonexecuting environment grammar: one assignment per line, optional indentation
// and export, single/double quotes, shell-style backslash escapes, and comments.
// Expansion, command substitution, multiline values, and adjacent quoted/unquoted
// word concatenation are deliberately rejected.
export function parseEnvironmentLines(text) {
  return String(text).split(/\r?\n/).map((line, index) => {
    if (line.includes('\0')) throw new Error(`invalid environment format at line ${index + 1}`);
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
    if (!match) {
      if (!line.trim() || line.trimStart().startsWith('#')) return { line };
      throw new Error(`invalid environment format at line ${index + 1}`);
    }
    let i = match[0].length, value = '', quote = null, closed = false;
    if (line[i] === "'" || line[i] === '"') quote = line[i++];
    while (i < line.length) {
      const ch = line[i++];
      if (quote && ch === quote) { closed = true; break; }
      if (!quote && (ch === ' ' || ch === '\t')) { i--; break; }
      if (ch === '\\' && quote !== "'") {
        if (i === line.length) throw new Error(`invalid environment escape at line ${index + 1}`);
        const next = line[i++];
        if (quote === '"' && !'\\"$`'.includes(next)) value += '\\';
        value += next;
      } else {
        if (quote !== "'" && (ch === '$' || ch === '`')) throw new Error(`environment expansion not supported at line ${index + 1}`);
        if (!quote && (';|&<>()'.includes(ch) || ch === '"' || ch === "'")) throw new Error(`invalid environment value at line ${index + 1}`);
        value += ch;
      }
    }
    if (quote && !closed) throw new Error(`unterminated environment quote at line ${index + 1}`);
    // A # immediately after a closing quote is part of the same shell word,
    // not a comment. This grammar does not support adjacent word segments.
    if (quote && i < line.length && line[i] !== ' ' && line[i] !== '\t') throw new Error(`environment concatenation not supported at line ${index + 1}`);
    const tail = line.slice(i).trim();
    if (tail && !tail.startsWith('#')) throw new Error(`invalid environment format at line ${index + 1}`);
    return { line, key: match[1], value };
  });
}
export function parseEnvironment(text) {
  const result = Object.create(null);
  for (const { key, value } of parseEnvironmentLines(text)) {
    if (!key) continue;
    if (key === 'BURROW_SETTINGS_KEY' && Object.hasOwn(result, key) && result[key] && result[key] !== value) throw new Error('conflicting BURROW_SETTINGS_KEY assignments');
    result[key] = value;
  }
  return result;
}
export function quoteEnvironment(value) {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(String(value))) return String(value);
  return '"' + String(value).replace(/[\\"$`]/g, '\\$&') + '"';
}
