# Resident chat acceptance fixture

`node scripts/resident-chat-fixture/build.mjs`, then `python3 scripts/resident-chat-fixture/serve.py` prints an ephemeral local port.

Uses production runtime hydration, catalog reconciliation, model selector/writer, session and send hooks, chat, and CSS. All fetches are synthetic; CSP prohibits real connections. Google is first in the synthetic catalog; Gerald's saved selection is OpenAI All / GPT-6-Luna. Session discovery is delayed to reproduce automatic error clearing. The initial error should remain after hydration, with Dismiss available. Sending returns a synthetic HTTP 503; the draft stays and the receipt must include `modelConnectionId: lb`. Toggle LB availability to verify unavailable identity rather than Google fallback; Send must be disabled. No live creature, credentials or providers are used.
