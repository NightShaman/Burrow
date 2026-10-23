const REFERENCE = /^\{\{([a-z][a-z0-9-]{0,31}):([^{}]{1,512})\}\}$/;
const SAFE_TYPE = new Set(['credential', 'secret', 'token', 'password', 'private-key']);

function providers(mods = [], scheme = null) {
  return mods.filter(mod => mod?.status === 'loaded' && mod.host && Array.isArray(mod.secretReferenceSchemes)
    && mod.secretReferenceSchemes.some(value => !scheme || value === scheme));
}

function cleanEntry(entry, scheme) {
  if (!entry || typeof entry !== 'object' || typeof entry.reference !== 'string' || entry.reference.length > 600) throw new Error('secret_reference_provider_result_invalid');
  const parsed = entry.reference.match(REFERENCE);
  if (!parsed || parsed[1] !== scheme || typeof entry.label !== 'string' || !entry.label.trim() || entry.label.length > 240) throw new Error('secret_reference_provider_result_invalid');
  const type = SAFE_TYPE.has(entry.type) ? entry.type : 'secret';
  const optional = Object.fromEntries(['username', 'url', 'service'].flatMap(name => typeof entry[name] === 'string' && entry[name].length <= 500 ? [[name, entry[name]]] : []));
  return { reference: entry.reference, label: entry.label, type, ...optional };
}

export async function listSecretReferences(mods = [], { scheme = null } = {}) {
  if (scheme !== null && (typeof scheme !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(scheme))) throw Object.assign(new Error('secret_reference_scheme_invalid'), { statusCode: 400 });
  const entries = [];
  for (const mod of providers(mods, scheme)) {
    for (const currentScheme of mod.secretReferenceSchemes.filter(value => !scheme || value === scheme)) {
      const result = await mod.host.invoke(`secret-reference-list:${currentScheme}`, {});
      if (!result || !Array.isArray(result.references) || result.references.length > 10_000) throw new Error('secret_reference_provider_result_invalid');
      entries.push(...result.references.map(entry => cleanEntry(entry, currentScheme)));
    }
  }
  return { references: entries };
}

export async function resolveSecretReference(mods = [], reference) {
  const parsed = typeof reference === 'string' ? reference.match(REFERENCE) : null;
  if (!parsed) throw Object.assign(new Error('secret_reference_invalid'), { statusCode: 400 });
  const matches = providers(mods, parsed[1]);
  if (matches.length !== 1) throw new Error(matches.length ? 'secret_reference_provider_ambiguous' : 'secret_reference_provider_unavailable');
  const result = await matches[0].host.invoke(`secret-reference-resolve:${parsed[1]}`, reference);
  if (!result || typeof result.value !== 'string') throw new Error('secret_reference_provider_result_invalid');
  return result.value;
}

export function isSecretReference(value) { return typeof value === 'string' && REFERENCE.test(value); }
