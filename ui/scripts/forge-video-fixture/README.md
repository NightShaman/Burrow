# Forge saved video reference fixture

Uses the actual Forge component/styles. All API calls are intercepted in memory;
unexpected calls fail. No backend writes, arbitrary uploads, or paid generation.
Use the existing Vite server, without restarting it.

Run `node scripts/forge-video-fixture/export-catalog.mjs` to regenerate `catalog.json`
by importing the actual sibling backend `src/forge-store.mjs` `forgeCatalog` function.
The sanitized input uses Google native API, connection `google`, model
`models/gemini-omni-1.2-flash`, accepted output `video`, input `text`/`image`,
and existing endpoint/auth defaults. No credentials or live settings are read.
This is real backend capability projection, not a live provider execution.
Portrait metadata and existing-image jobs remain synthetic isolated UI fixtures.
The synthetic PNG is drawn locally; it is not a paid generated output.

- `/scripts/forge-video-fixture/index.html` — native Omni video/reference catalog
- `?state=unsupported` — same model with an explicit text-only input configuration;
  actual backend projection leaves video available but saved references unavailable
- `?state=error` — request rejects with `forge_reference_artifact_invalid`; select Video,
  add the Forge image and a portrait, enter a prompt, then submit to show the error.
  The URL alone does not perform those interactions.
- `?state=empty` — no saved portraits

`node scripts/forge-video-fixture/capture.mjs` captures 1920×1200 normal,
selected-reference, existing-image detail, artifact-reference, unsupported and error
states plus 900×1000 and 480×1000 error states.
Output defaults to `/tmp/forge-video-evidence`; override `FORGE_EVIDENCE_DIR`.
`EXPECT_BEFORE=1` captures only baseline video against the pre-change component.
The preserved historical before screenshot used the original Veo mock catalog;
current after screenshots use Omni and are not an identical-catalog comparison.
These are API-fixture UI observations, not evidence of live provider generation.
The UI caps combined saved-portrait/artifact references at six; backend validation
is still authoritative. The fixture records request payloads but does not validate
provider dispatch or ownership. Final capture requires a refreshed actual backend
catalog with explicit per-model referenceArtifacts capability.
