# Populated Tasks layout fixture

Mounts the actual Tasks page, editor, ConfirmProvider, and production CSS with a read-only in-memory fetch adapter. No backend data is read or mutated. Mutations and unexpected requests fail explicitly. This verifies presentation, not live backend integration or attachment persistence.

Build: `node scripts/task-activity-fixture/build.mjs`
Serve: `python3 -m http.server 8766 --bind 0.0.0.0 --directory scripts/task-activity-fixture/bundle`
Verify in local Chromium: `node scripts/task-activity-fixture/headless.mjs` (requires that server).

Checks 1440, 375, and 320 CSS px, populated document/history rows, chronological order, closed disclosures, dialog/content horizontal containment, disclosure expansion and scroll reachability. Screenshots go to `/tmp/task-activity-{width}.png`.
