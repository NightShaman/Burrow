// Read-only cross-repository check; never imports a store or dispatches a job.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { forgeCatalog } from '../../../Burrow-Backend/src/forge-store.mjs';
import { normalizeImageOptions } from '../../../Burrow-Backend/src/model-adapters/image-generation-options.mjs';

const expected = JSON.parse(await readFile(new URL('./catalog-capability.json', import.meta.url)));
const configs = ['gpt-image-2.6-sunburst', 'gpt-image-2.6-flare'].map((model) => ({
  apiType: 'openai-responses',
  provider: 'openai',
  model,
}));
const catalog = forgeCatalog([
  {
    id: 'contract',
    apiType: 'openai-responses',
    provider: 'openai',
    models: [
      ...configs.map(({ model }) => ({ id: model, acceptedOutput: ['image'] })),
      { id: 'unknown-image', acceptedOutput: ['image'] },
    ],
  },
]);
for (const model of catalog.models.slice(0, 2)) assert.deepEqual(model.imageOptions, expected);
assert.equal(catalog.models[2].imageOptions, undefined);
const file = new URL('../../src/features/forge/ForgeImageOptions.tsx', import.meta.url);
const source = await readFile(file, 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    jsx: ts.JsxEmit.ReactJSX,
  },
}).outputText;
const ui = {};
new Function('require', 'exports', compiled)(createRequire(fileURLToPath(file)), ui);
assert.equal(ui.imageDraftOptions(ui.defaultImageDraft()), undefined);
let checked = 0;
for (const config of configs) {
  for (const size of expected.sizes) {
    const draft = { ...ui.defaultImageDraft(), outputFormat: 'gif', size, frameDurationMs: '207' };
    assert.equal(ui.imageDraftError(draft), '');
    const payload = ui.imageDraftOptions(draft, true);
    assert.deepEqual(normalizeImageOptions(payload, { config }), payload);
    checked++;
  }
  for (const outputFormat of ['png', 'jpeg', 'webp']) {
    const payload = ui.imageDraftOptions({ ...ui.defaultImageDraft(), outputFormat }, true);
    assert.deepEqual(Object.keys(payload), ['outputFormat']);
    assert.deepEqual(normalizeImageOptions(payload, { config }), { ...payload, size: 'auto' });
    checked++;
  }
}
console.log(
  JSON.stringify(
    {
      ok: true,
      catalog,
      payloadsChecked: checked,
      untouchedStillOptionsOmitted: true,
      paidRequests: 0,
    },
    null,
    2,
  ),
);
