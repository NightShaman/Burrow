# Shared range control acceptance

Operator request (2026-11-06), verbatim:

> ok so I need you to fix something.  Can you fix all your fucking sliders they do this. Also they should match part of the theme not be some rando blue

The attached screenshot shows a native blue slider on a dark surface. No behavior changes were requested. The candidate uses the theme's existing accent for every native range thumb and a themed neutral track, resets inherited text-field padding/borders, and gives the thumb a 28px-high input area. The chat-specific 4px input-box styling is removed; chat width and save/lock behavior are preserved.

## Scope and provenance

- Repository: Burrow-UI.
- Initial baseline: `5e46ae7`; Hatchet's concurrent independent audit landed as `a31e3e3` during this task. Its changes are not part of this candidate.
- Candidate: only `src/app.css`, `src/styles/workspace.css`, `src/styles/ranges.css` and this fixture directory.
- Uses actual production ChatModelSelector, MinionDepthSettings, DefaultMinionModel, CuratorSettings, AgentDreams plus unwrapped mod range examples. Synthetic API responses; no real settings writes.
- `bundle-before/` was built before slider source edits. Only its HTML asset URLs were made relative so both bundles can be served side by side. Generated bundles/evidence are ignored, not committed.

## Verification

- Focused regression run: 145 tests passed across ChatTemperature, MinionDepthSettings, DefaultMinionModel, CuratorSettings, AgentDreams. Log: `/tmp/smatchet-range-tests.log`.
- Production build passed. Log: `/tmp/smatchet-range-production-build.log` (existing chunk-size advisory only).
- Browser acceptance passed: seven ranges (six enabled plus disabled sample), all nine built-in themes at 1440px and 1000px, actual keyboard endpoints/step, pointer dragging, settings PUT completion, disabled/save-only rendering, and native forced-color appearance.
- Browser log: `/tmp/smatchet-range-browser.log`; measurements: `evidence/results.json`.
- Comparable screenshots: `evidence/before-smatchet-{1440,1000}.png` and `evidence/after-smatchet-{1440,1000}.png`. Also Halloween/Hatchet at both widths, keyboard min/max focus, lock, save-only, forced-color states.
- Screenshots reviewed using granted DevTools. Browser interaction coverage is Chromium; Firefox selectors supplied but Firefox not run. Real components are rendered in a synthetic layout, not a live production settings session.
- Full suite log/result: `/tmp/smatchet-range-full-tests.log`, `/tmp/smatchet-range-full-tests.exit`.

## Reproduce

```sh
node scripts/range-controls-fixture/build.mjs
python3 -m http.server 46735 --bind 127.0.0.1 --directory scripts/range-controls-fixture
# In another shell, with a pre-change bundle-before retained if comparing:
node scripts/range-controls-fixture/headless.mjs
```

The acceptance runner uses one page in one temporary Chromium process and removes its profile in `finally`. Stop the fixture HTTP server after use. No shared live services are restarted or deployed.

## Independent review

Fresh `gpt-6-luna` review (child `subagent-1794011305834-fe6126b8`) inspected candidate over `a31e3e3` read-only: functional correctness **Pass**, scope/behavior **Pass**. It read supplied passing logs, including full suite **210 files / 2,063 tests passed** (exit 0). Limitation: reviewer could not render PNGs with its available tools; parent performed visual acceptance using DevTools. Firefox remains untested. No evidenced defects found.
