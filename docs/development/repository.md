# Repository and source ownership



Burrow is assembled from separate source repositories; public promotion publishes a curated snapshot of that distribution. The backend and UI originate in separate source repositories; the assembly records the exact commits it used.

## Reviewed snapshot

| Artifact | Revision |
|---|---|
| Development assembly | `f9d1bc5b1b04e3d7f29c6b4f62e0feb935bff487` |
| Build | `2026.10.25.9` |
| Backend source | `3bf50374d3601c821e787912d52b9044eaf649ec` |
| UI source | `0610bac85b2e636b79bbdf09fc3a95c3a519fa5a` |

These pins describe the documentation's evidence baseline, not a claim about every running installation. Read your installed `SOURCE_VERSIONS` and health version when investigating a deployment.

## Assembled tree

```text
Burrow/
├── PUBLIC_RELEASE.json      public promotion provenance (public snapshots)
├── backend/
│   ├── bin/                 Node CLI
│   ├── global-skills/       bundled runtime instruction skill
│   ├── public/              local API UI assets
│   ├── scripts/             server, route modules, operational tools
│   └── src/                 runtime, providers, tools, stores
├── ui/
│   ├── src/                 React/TypeScript source and colocated tests
│   ├── public/              frontend public assets
│   └── dist/                generated frontend bundle
├── Dockerfile
├── docker-entrypoint.sh
├── compose.yml
├── install.sh
├── SOURCE_VERSIONS
└── docs/                    upstream MkDocs documentation
```

The public promotion adds its release provenance; a development assembly need not contain `PUBLIC_RELEASE.json`. The consolidated Docusaurus website lives separately in Docs-Website.

The repositories are combined by copying files, not Git submodules. The public payload omits backend tests and deployment-source directories, but includes `backend/docs/openapi.json`. UI source tests and `vitest.config.ts` are included. Do not assume the public payload contains the complete contributor test environment.

## Ownership rules

| Public file/area | Authoritative origin |
|---|---|
| `backend/src`, `bin`, `scripts`, `global-skills`, `public` | Backend source |
| `ui/src`, `public`, manifests/build configuration | UI source |
| `ui/dist` | UI build during assembly |
| Root installer | Backend `deploy/installer/install.sh` |
| Root Docker/Compose/entrypoint files | Backend `deploy/docker` |
| Root README and `docs/assets/` presentation | Public Burrow repository |
| `SOURCE_VERSIONS` and stamped versions | Assembly workflow |
| Root MkDocs site/tooling | Public Burrow repository |
| Root license, governance files, and workflow configuration | Public Burrow repository |

An app-source correction belongs in its source repository and should be regenerated. Direct edits to generated runtime copies can disappear on assembly. Repository presentation, documentation, governance, and workflow files are curated in Burrow and survive assembly unchanged.

Assembly replaces only the explicit runtime and release payload: `backend/`, `ui/`, root container files, root installers, and `SOURCE_VERSIONS`. It does not source the root README or artwork from Backend or UI.

## Source links and accessibility

The manual prefers public commit-pinned source links so readers can inspect its evidence. Authorized contributors can use the separate Backend and UI source repositories for full development history/tests. Those repositories may be private; lack of access does not prevent reading the public assembled runtime.

Generated bundles and dependency locks are inventory/build evidence, not preferred sources for explaining behavior. Source and tests take priority over stale comments, help text, historical runbooks, or planning documents.

See [source map](../project/source-map.md), [architecture](../architecture/overview.md), and [release process](releases.md).

## Source review

Reviewed on 25 October 2026 against development assembly `f9d1bc5b1b04e3d7f29c6b4f62e0feb935bff487` (build2026.10.25.9), Backend `3bf50374d3601c821e787912d52b9044eaf649ec` and UI `0610bac85b2e636b79bbdf09fc3a95c3a519fa5a`. This is static source review, not a claim that tests, installation or provider calls were run. Public snapshots can lag development; these pins are provenance, not an installed-version compatibility promise.
