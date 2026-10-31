# Isolated AgentSchedules acceptance fixture

This fixture builds the integrated production `AgentSchedules` inside the real Settings primary/overflow column classes, with production CSS, `ConfirmProvider`, and `UnsavedChangesProvider`. The surrounding navigation and agent selector are inert visual context, not the full app. The selected synthetic agent is `smatchet`; the synthetic operator-timezone endpoint returns `America/Chicago`.

Only `scripts/schedules-fixture/` supplies fixture behavior. It has no backend, live schedules, runtime, or git access, and it does not change source or package configuration.

## Build and serve (on demand)

From the repository root:

```sh
node scripts/schedules-fixture/build.mjs
python3 scripts/schedules-fixture/serve.py --host 10.10.20.105 --port 0
# Open http://10.10.20.105:<printed PORT>/ in a browser.
```

`--port 0` (the default) lets the OS choose an available high port; pass a specific port if preferred. The server defaults to `127.0.0.1`, so the private-interface override is needed only for a remote browser. Stop it with Ctrl-C. It serves only `bundle/`, rejects API paths, has **no proxy**, and retains a restrictive offline CSP including `connect-src 'none'`. Use a trusted private interface: the fixture server has no authentication.

The bundle is ignored and must be rebuilt after source or fixture changes. A generated bundle is not evidence that a later version has been tested. Build and typecheck do not start a server or browser.

```sh
node scripts/schedules-fixture/build.mjs
node_modules/.bin/tsc -p scripts/schedules-fixture/tsconfig.json --pretty false
npm test -- scripts/schedules-fixture/fixture-contract.test.ts
```

## Isolation and fail-closed behavior

All application `fetch` calls are intercepted in document memory. The fixture implements only the schedule/timezone and task-board reads needed by this integrated component. Unknown methods, paths, query shapes, and origins are recorded and throw; they never fall through to a network. The server CSP provides a second boundary with `connect-src 'none'`.

Schedule POST/PATCH/DELETE changes exist only in that tab until page reload. Saving only canonicalizes in-memory synthetic data; it never executes a task or starts a run. `POST /api/scheduled-jobs/:id/trigger` is explicitly refused with **403** and `fixture_execution_disabled`. A mod-managed job is read-only at the synthetic endpoint.

The fixture controls include a visible **Local evidence** panel, so request data can be inspected even when script evaluation is unavailable. It shows the latest request method/path/status/body **and synthetic response**, blocked-request count, and the exact synthetic Open chat callback arguments. DevTools helpers remain available as an additional convenience.

## Contract represented by fixture data and mock API

- Prompt/recurring and prompt/once jobs; an eligible task job; jobs retained for a Done and missing task; a long title; a managed job; inherited and explicit model selections; successful/skipped/failed last-run receipts.
- New task selection is eligible only when the saved board task is unarchived, assigned to Smatchet, and in `todo`. PATCH retains a task selection that later becomes Done, reassigned, archived, or missing; only a changed task selection is revalidated.
- Task job writes require and persist `sessionId: "default"` and `contextMode: "continue"`. Prompt writes canonicalize task-only state away. The mock rejects unknown writable fields instead of silently dropping them.
- Recurring jobs always return `runAt: null`; one-time jobs always return `cron: null`. An offsetless `datetime-local` `runAt` is interpreted as an `America/Chicago` wall time and stored as a UTC ISO instant. A supplied ISO value with `Z` or an explicit numeric offset is retained unchanged. A nonexistent Chicago DST wall time is rejected rather than shifted silently.
- The integrated component renders its normal Open chat action for a completed receipt. Here its callback records the exact synthetic `sessionId` and receipt `agentId` in the visible Local evidence panel; it does not navigate, load a chat, or make a network request.

## Fixture controls

Expand **Fixture controls & evidence** in the lower right to change the saved weekly task's status, reassign, archive, delete, restore tasks, reset all data, or clear request/chat evidence. Task-state actions remount the schedule editor and re-fetch the synthetic board; if a form is dirty, the normal unsaved-changes guard appears first. Close the controls for screenshots.

Use the controls to demonstrate retention behavior: open **Weekly release readiness task**, make the saved task ineligible, let the editor remount, then pause or otherwise PATCH the unchanged selection. It remains identifiable and accepted. To demonstrate a new selection guard, choose a new task job and note that only the grouped eligible To Do tasks are offered.

The local evidence panel confirms the request body after saves, including task `sessionId`/`contextMode`, `cron: null` for Once, and ISO-normalized `runAt`. It also reports the deliberate 403 after pressing **Run now** and records the harmless Open chat callback.

## Browser timezone versus operator timezone

The operator timezone comes from the synthetic `/api/settings/timezone` response and is `America/Chicago`. It controls how the integrated component displays saved ISO instants and what the fixture API uses to interpret an edited offsetless `datetime-local` value. The browser's own timezone is separate: it can affect the native `datetime-local` picker UI and screenshots, but it does **not** alter fixture API normalization. Set a browser DevTools timezone override to `America/Chicago` only when you want the native picker/chrome itself to match the operator zone visually.

## DevTools (optional)

```js
window.__schedulesFixture.snapshot()               // deep-cloned timezone/projects/tasks/jobs/chat callbacks
window.__schedulesFixture.requests                 // ordered method, path, parsed body, response status, timestamp
window.__schedulesFixture.chatOpens                // exact fixture-local Open chat callback records
window.__schedulesFixture.unexpected               // blocked unknown requests
window.__schedulesFixture.setTaskStatus('task-weekly-review', 'done')
window.__schedulesFixture.reassignTask('task-weekly-review', 'hatchet')
window.__schedulesFixture.archiveTask('task-weekly-review')
window.__schedulesFixture.deleteTask('task-weekly-review')
window.__schedulesFixture.restoreTasks()           // preserves saved jobs
window.__schedulesFixture.reset()                  // restores synthetic jobs/tasks and clears chat callbacks
window.__schedulesFixture.clearRequests()
window.__schedulesFixture.clearChatOpens()
```

These helpers act directly; use visible controls when testing the unsaved-changes guard. Status choices are `backlog`, `todo`, `in_progress`, `review`, and `done`. Unsupported behavior is deliberately blocked and visible in the evidence panel rather than proxied or masked.
