# Development setup

Keep development sources and test state separate from any installed Burrow runtime. Documentation builds do not require a running application, provider credentials, or database.

## Choose the correct checkout

- The public **Burrow** repository contains an assembled backend/UI payload and this documentation
- **Burrow-Backend** owns runtime source, full backend tests, upstream API artifacts, and deployment source
- **Burrow-UI** owns frontend source, UI tests/configuration, and upstream UI documentation

Backend/UI source repositories may require repository access. Do not infer access to them merely from a public Burrow clone. See [repository layout](repository.md).

For documentation-only work, use [the documentation workflow](documentation.md). Do not install or start the runtime simply to edit prose.

## Backend contributor environment

Use Node24+ and npm. In an authorized Backend checkout:

```sh
npm ci
npm run check:postgres-only
npm run test:files -- tests/agent-context-config.test.mjs
npm test
```

`npm run check` also syntax-checks source/tests/bin/scripts and runs the suite. Inspect the exact scripts before selecting the aggregate check for your change. The public assembly does not contain backend tests or upstream docs, so these commands do not have the same meaning in its bundled `backend/` directory.

The test runner creates private temporary runtime roots, clears selected runtime/key environment values, provides a test-only key, and enforces a whole-suite timeout (120 seconds locally by default; configurable through `BURROW_TEST_TIMEOUT_MS`). Do not point tests at a deployed database or live workspace.

Some database integration tests are opt-in and need PostgreSQL17/pgvector or Docker. Passing pure tests, or skipping unavailable integration tests, is not equivalent to a full database lifecycle pass. The optional deployed-isolation verification mode reads deployed paths; do not use it without intentionally selecting that environment.

## Frontend contributor environment

In an authorized UI checkout:

```sh
npm ci
npm test
npm run build
```

The source UI uses React/TypeScript/Vite and Vitest. `npm run build` performs TypeScript checking and creates `dist/`. `npm run dev` starts Vite; `npm run body` selects the source workflow's standard UI port. Inspect `package.json` and `vite.config.ts` before exposing the development server or connecting it to a runtime.

Use an isolated development API target. A local frontend can still issue real mutations to whichever backend is selected. Browser origin and backend execution host are different concepts.

## API contract checks

In the Backend source tree:

```sh
npm run openapi:validate
npm run openapi:drift
npm run openapi:types:check
npm run postman:check
```

These check schema structure, literal-route coverage, generated TypeScript, and generated Postman content. They do not replace method/body/authorization review against handlers.

!!! note "Check scripts against the source checkout"
    `openapi:check` includes `tests/live-api-contract.test.mjs`; the public assembly does not ship the backend test tree, so confirm that stage exists in your authorized Backend checkout before running the aggregate. `runtime:restore:rehearsal` is no longer defined in the published backend package. Use the supported lifecycle rehearsal below for its documented coverage. Report missing/skipped stages explicitly; a subset passing is not an aggregate pass.

## Database migration development

Keep published migration definitions immutable and append new versions. Test fresh startup, repeat startup, rollback on a failed migration, and refusal of a future/incompatible ledger in an isolated database. See [persistence](../architecture/persistence.md) and [storage schema](../reference/storage-schema.md).

The existing lifecycle rehearsal uses a disposable PostgreSQL17/pgvector Docker container and exercises concurrent migration, rollback, dump/restore, and restart. Review its prerequisites and commands before running; it invokes Docker through noninteractive sudo and is not a production-volume acceptance test.

## Before proposing a change

1. Check repository status and nearby conventions
2. Identify source versus generated ownership
3. Add focused regression coverage where behavior changes
4. Run applicable checks and report skipped/blocked stages
5. Update API/config/docs if the public contract changes
6. Keep runtime state, credentials, and generated dependency directories out of the diff

Source pushes can trigger assembly through the upstream dispatch workflow. A source push and a running user's upgrade are distinct events; do not restart or update a live runtime as an unrequested development step.

## Source evidence

- [Backend scripts](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/package.json)
- [Test isolation runner](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/scripts/test-runtime.mjs)
- [PostgreSQL lifecycle rehearsal](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/scripts/postgres-lifecycle-rehearsal.mjs)
- [UI package scripts](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/ui/package.json)
- [Assembly verification](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/.github/workflows/assemble.yml)
