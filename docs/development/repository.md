# Repository and source ownership

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
| Root README | Backend `deploy/README.md` |
| `SOURCE_VERSIONS` and stamped versions | Assembly workflow |
| Root MkDocs site/tooling | Documentation maintained in public Burrow |

An app-source correction belongs in its source repository and should be regenerated. Direct edits to generated copies can disappear on assembly. This docs project does not alter runtime source to repair discovered behavior.

Root README is regenerated. Documentation integration instructions must account for that owner rather than assuming a local README edit is permanent. The assembly's replacement list leaves the root MkDocs documentation tree and a separate docs workflow intact.

## Source links and accessibility

The manual prefers public commit-pinned source links so readers can inspect its evidence. Authorized contributors can use [Burrow-Backend](https://github.com/NightShaman/Burrow-Backend) and [Burrow-UI](https://github.com/NightShaman/Burrow-UI) for full development history/tests. Those repositories may be private; lack of access does not prevent reading the public assembled runtime.

Generated bundles and dependency locks are inventory/build evidence, not preferred sources for explaining behavior. Source and tests take priority over stale comments, help text, historical runbooks, or planning documents.

See [source map](../project/source-map.md), [architecture](../architecture/overview.md), and [release process](releases.md).

## Source evidence

- [Version pins](https://github.com/NightShaman/Burrow/blob/2d979fecca8434fe02a6ed2e8225c46eb4690098/SOURCE_VERSIONS)
- [Materialization and version stamping](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/.github/workflows/assemble.yml)
