# Bundled Scalar API reference

This directory contains the pinned browser bundle used by Burrow's `/api/docs` endpoint.

- Package: `@scalar/api-reference`
- Version: `1.64.1`
- Source contract: `docs/openapi.json`
- Runtime owner: Burrow backend
- `scalar.js` SHA-256: `397f33ac357dd4de28ea124499e97e315db98251015ea7e2b9870b575a4a1c3d`
- `scalar.css` SHA-256: `babaf44b3e3f3aad5a5bb00d0672e3cbeb5686b6e20682e9b4429309f3b24621`

Regeneration/update procedure: obtain the matching `@scalar/api-reference` browser assets for the pinned version, replace both files, update the hashes above with `sha256sum`, then run `npm run openapi:check`. The repository test verifies that both assets remain present, locally served, and synchronized with this provenance record; it does not permit a CDN fallback.

The files are intentionally separate from `public/ui`, which is the externally supplied BurrowClaw-UI artifact directory.
