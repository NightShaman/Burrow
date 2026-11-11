import { forgeCatalog } from '../../../Burrow-Backend/src/forge-store.mjs';
import { writeFile } from 'node:fs/promises';

// Pure catalog projection: no settings reads/writes, credentials, or provider calls.
const connection = {
  id: 'google',
  provider: 'Google',
  apiType: 'google-generative-language',
  models: [
    {
      id: 'models/gemini-omni-1.2-flash',
      name: 'Gemini Omni 1.2 Flash',
      selected: true,
      acceptedOutput: ['video'],
      acceptedInput: ['text', 'image'],
    },
  ],
};
const catalog = forgeCatalog([connection]);
const textOnlyCatalog = forgeCatalog([
  {
    ...connection,
    models: connection.models.map((model) => ({ ...model, acceptedInput: ['text'] })),
  },
]);
if (!catalog.video.available || !catalog.models[0]?.agentReferenceImage.available)
  throw new Error('Native Omni video/reference catalog unavailable');
if (
  !catalog.models[0]?.referenceArtifacts?.available ||
  catalog.models[0]?.referenceArtifacts?.maxImages !== 6
)
  throw new Error('Native Omni artifact reference capability unavailable');
if (textOnlyCatalog.models[0]?.referenceArtifacts?.available)
  throw new Error('Text-only fixture incorrectly accepts artifact references');
if (textOnlyCatalog.models[0]?.agentReferenceImage.available)
  throw new Error('Text-only fixture incorrectly accepts references');
await writeFile(
  new URL('./catalog.json', import.meta.url),
  JSON.stringify({ connection, catalog, textOnlyCatalog }, null, 2) + '\n',
);
console.log('Exported real forgeCatalog Omni and explicit text-only-input variant.');
