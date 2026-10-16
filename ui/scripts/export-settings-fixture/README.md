# Portable settings export/import acceptance

Build: `node scripts/export-settings-fixture/build.mjs`.
Run: `node scripts/export-settings-fixture/headless.mjs`.
Manual inspection: `python3 scripts/export-settings-fixture/serve.py` prints its
OS-selected port. Only bundle/ is served; CSP denies API/network connections.
The runner owns and cleans its temporary Chromium profile and fixture server.

Uses the actual ExportSettings, shared confirmation and app CSS in the existing
four-column Settings hierarchy. catalog.json is a safe metadata snapshot from
Burrow-Backend/src/export-service.mjs at 17ed0af4; it is fixture data, not a
production category list. Production categories/descriptions remain API-owned.
Checks eight categories, explicit-only selection, secret password gating,
password clearing, encrypted import challenge, expanded preview, confirmation
cancel/apply, focus containment, primary/supporting placement, reachable import
controls and 375/1280 viewport page overflow.

Synthetic APIs only. The bundle download is deliberately dummy content, not
actual encryption. This does not prove backend encoding, real import, scheduler
execution, external skill installation, or live/deployed integration. No packages
are installed and scripts/ is not part of the production build.
