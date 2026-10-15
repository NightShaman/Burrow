# Preventive ownership acceptance fixture

Build: `node scripts/preventive-ui-fixture/build.mjs`.
Automated Chromium acceptance: `node scripts/preventive-ui-fixture/headless.mjs`.
Manual: `python3 scripts/preventive-ui-fixture/serve.py` prints its OS-selected port.
Only bundle/ is served, never the repository. All API calls are local fixture
responses; CSP denies network connections. No live agent/run/setup mutations.

Mounts actual Archive shelves, AgentToolbar/ordinary dialog/durable first-run
wizard, and useChatSession/useChatRecovery with synthetic API responses and real
application CSS. Checks aborted late Archive pagination, filter-owned reader
selection, failure/retry, empty-registry ordinary creation, confirmed-create
refresh retry (one POST), dialog focus containment/Escape, exact lost-response
setup replay and finale, recovered external-run identity/stop/terminal refresh,
and draft preservation across a 100-session selector. It reports narrow/desktop
page overflow. Separate tests exercise pending-turn/cache races and OAuth hooks;
no real OAuth/provider/network or deployed-app acceptance is claimed.

The main production build does not include scripts/ fixtures. Dependencies are
used from the existing install; no test framework/browser package is added.
