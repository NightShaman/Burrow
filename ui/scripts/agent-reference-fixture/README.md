# Canonical agent reference photo browser fixture

Build before/after: `node scripts/agent-reference-fixture/build.mjs --before && node scripts/agent-reference-fixture/build.mjs`.
Serve: `python3 scripts/agent-reference-fixture/serve.py` (isolated OS-selected port; serves bundle only). Open `/before/` or `/after/`.

Mounts actual AgentSettings, AgentDetails, shared guard and app CSS. The before build uses AgentDetails at e1d564b. API is replaced at build time with an in-memory reference-image contract; it never contacts a backend or persists photos. Preview bytes are decoded locally from data URLs. Minion read responses are synthetic; minion editing is outside this fixture's scope. No generation or live mutations.

Verify upload, original composition preview, replacement, remove, owner switch; type an unfinished name and verify photo actions do not save it. Fail photo writes checkbox supports retry and shared Save/Discard/Stay. Compare screenshots at the same desktop viewport; check long filenames and narrow view. Run `node scripts/agent-reference-fixture/headless.mjs` for disposable Chromium upload/retry/selection/removal checks and screenshots in `/tmp/agent-reference-acceptance`. This is frontend acceptance, not backend integration.

For exact 1920×1200 desktop captures: `node scripts/agent-reference-fixture/headless.mjs /tmp/agent-reference-acceptance-1920 1920 1200`. Desktop baseline/empty/photo/error/removal use that viewport; narrow probes remain 1024/600/375 ×1000. `bundle/` (including generated screenshot galleries) is gitignored and must not be staged.
