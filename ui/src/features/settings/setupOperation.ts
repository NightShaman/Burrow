import { secureUuid } from '../../app/secureUuid';
import { retainedOperation } from '../../app/durableOperation';

const profileDocumentKinds = [
  'SOUL',
  'RULES',
  'ORIENTATION',
  'PREFERENCES',
  'TOOLS',
  'DREAM_MEMORY',
] as const;

export const agentIdFromName = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
export function setupOperation({
  operatorName,
  operatorAvatar,
  name,
  avatar,
  soul,
  connectionId,
  model,
}: {
  operatorName: string;
  operatorAvatar: string;
  name: string;
  avatar: string;
  soul: string;
  connectionId: string;
  model: string;
}) {
  const key = 'hc.setupOperation';
  const payload = retainedOperation(key, () => ({
    operationId: secureUuid(),
    operator: { name: operatorName.trim(), avatar: operatorAvatar },
    agent: { id: agentIdFromName(name.trim()), name: name.trim(), enabled: true },
    agentIdentity: { avatar },
    documents: profileDocumentKinds.map((kind) => ({
      kind,
      markdown: kind === 'SOUL' ? soul : '',
    })),
    ...(connectionId && model ? { modelSelection: { connectionId, model } } : {}),
  }));
  // Only repair the known pre-fix five-kind submission. The backend rejects it
  // transactionally before recording an operation, so its durable ID is reusable.
  // Complete submissions (including lost responses) must remain byte-for-byte intact.
  const legacyKinds = profileDocumentKinds.filter((kind) => kind !== 'PREFERENCES');
  if (
    Array.isArray(payload.documents) &&
    payload.documents.length === legacyKinds.length &&
    legacyKinds.every((kind) => payload.documents.filter((doc) => doc.kind === kind).length === 1)
  ) {
    const documents = [...payload.documents];
    documents.splice(documents.findIndex((doc) => doc.kind === 'ORIENTATION') + 1, 0, {
      kind: 'PREFERENCES',
      markdown: '',
    });
    const repaired = { ...payload, documents };
    localStorage.setItem(key, JSON.stringify(repaired));
    payload.documents = documents;
  }
  return payload;
}
