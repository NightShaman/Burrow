import { load, JSON_SCHEMA } from 'js-yaml';

// Front matter is optional, but once opened it must be closed and valid YAML.
export function frontmatterMetadata(content = '') {
  const lines = String(content).split(/\r?\n/);
  if (lines[0] !== '---') return {};
  const end = lines.indexOf('---', 1);
  if (end < 0) throw new Error('skill_frontmatter_unclosed');
  let fields;
  try { fields = load(lines.slice(1, end).join('\n'), { schema: JSON_SCHEMA }); }
  catch (error) { throw new Error(`skill_frontmatter_invalid: ${error.message}`); }
  if (fields == null) return {};
  if (typeof fields !== 'object' || Array.isArray(fields)) throw new Error('skill_frontmatter_mapping_required');
  for (const key of ['name', 'description', 'version']) {
    if (fields[key] != null && typeof fields[key] !== 'string') throw new Error(`skill_frontmatter_string_required:${key}`);
  }
  return fields;
}
