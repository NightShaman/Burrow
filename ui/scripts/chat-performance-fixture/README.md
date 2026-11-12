# Chat poll/render acceptance

Synthetic API only; unknown requests fail closed. Uses real `useChatSession`,
`useChatInputs` and `ChatTranscript` with 200 Markdown messages. Does not send
messages, invoke providers or mutate any installed runtime.

From UI root:

```sh
node scripts/chat-performance-fixture/build.mjs
node scripts/chat-performance-fixture/build.mjs --baseline
python3 -m http.server 5188 --directory scripts/chat-performance-fixture
```

In a second shell:

```sh
CHAT_PERF_EVIDENCE=/tmp/chat-perf-after CHAT_PERF_FIXTURE_URL=http://127.0.0.1:5188/bundle node scripts/chat-performance-fixture/headless.mjs
CHAT_PERF_EVIDENCE=/tmp/chat-perf-before CHAT_PERF_FIXTURE_URL=http://127.0.0.1:5188/bundle-before node scripts/chat-performance-fixture/headless.mjs
```

Requires local `/snap/bin/chromium`, as existing fixture runners do. Baseline
bundles the five affected production modules from `cf509815`; candidate bundles
current source. Both use development React for Profiler measurements (not
production latency claims). Build-only instrumentation counts actual Markdown
and message function executions; no counters are shipped in production source.

Runner checks real unchanged polls, active refreshes, changed live answers,
terminal settlement, late Forge-shaped attachment delivery and queued input
projection. It also exercises scroll-up/jump-to-latest and checks overflow at
1920×1200 and 900×1000. Exact completion-relative poll cadence, discarded/failed
refresh retries, navigation fences and cancellation are covered by Vitest.

Screenshots and JSON are written to the explicit evidence directory. Generated
bundles and copied logo are ignored. A directly rendered source fixture is also
available through Vite at `/scripts/chat-performance-fixture/index.html`.
