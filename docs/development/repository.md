# Repository and source ownership

!!! warning "Earlier technical reference"
    This page is retained from earlier documentation and has not been fully revalidated for the public 2026.10.19 release. Its revision-specific links and examples may describe older or development behavior. Start with the [current public-release user guide](../guide/installation.md); do not use this page alone to select installation commands, image tags, or security settings.

Burrow's public repository is an assembled distribution. The backend and UI originate in separate source repositories; the assembly records the exact commits it used.

## Reviewed snapshot

| Artifact | Revision |
|---|---|
| Public Burrow | `2d979fecca8434fe02a6ed2e8225c46eb4690098` |
| Build | `2026.10.02.7` |
| Backend source | `5dcfa0b495441f9f12c733521b8aa431b14f50f8` |
| UI source | `b0aff4c0191ece14730bc3d7fd92018e6e126368` |

These pins describe the documentation's evidence baseline, not a claim about every running installation. Read your installed `SOURCE_VERSIONS` and health version when investigating a deployment.

## Public tree

```text
Burrow/
├── .github/workflows/assemble.yml
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
└── docs/                    this documentation site
```

The repositories are combined by copying files, not Git submodules. Backend `docs/`, `tests/`, and `deploy/` are omitted from the application payload. UI upstream docs and Vitest configuration are also outside the assembled copy.

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

The manual prefers public commit-pinned source links so readers can inspect its evidence. Authorized contributors can use  and  for full development history/tests. Those repositories may be private; lack of access does not prevent reading the public assembled runtime.

Generated bundles and dependency locks are inventory/build evidence, not preferred sources for explaining behavior. Source and tests take priority over stale comments, help text, historical runbooks, or planning documents.

See [source map](../project/source-map.md), [architecture](../architecture/overview.md), and [release process](releases.md).

