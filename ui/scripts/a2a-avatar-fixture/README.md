# A2A sender avatar acceptance

Real `ChatTranscript` and production CSS with synthetic avatars and messages. No live API calls or writes.

Build a candidate and serve the output:

```sh
A2A_FIXTURE_OUT=/tmp/smatchet-a2a-avatar/after node scripts/a2a-avatar-fixture/build.mjs
python3 -m http.server 8798 --directory /tmp/smatchet-a2a-avatar
```

The browser audit expects comparable baseline and candidate builds under `before/` and `after/`. Build the baseline fixture against the base revision of `ChatTranscript.tsx` using an isolated checkout or Vite loader override; do not replace the active working file. Run:

```sh
node scripts/a2a-avatar-fixture/audit.mjs
```

Optional environment variables: `A2A_FIXTURE_URL`, `A2A_EVIDENCE_DIR`, `CHROMIUM_BIN`. The audit compares known and unknown senders at 1850, 1024, and 390 pixels, checks loaded images, fallback initials, preserved message sides, equal avatar widths, overflow and runtime errors, and saves PNGs plus JSON. Inspect the screenshots for visual acceptance. Fixture portraits are test images, not saved resident/agent photos.
