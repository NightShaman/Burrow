# Native OpenAI reset visual acceptance

Build: `node scripts/openai-reset-fixture/build.mjs`
Serve: `python3 -m http.server 43342 --bind 0.0.0.0 --directory scripts/openai-reset-fixture/bundle`

The fixture renders the real AccountStatus and confirmation components with realistic account names, two usage windows, available/rate-limited/limit-exceeded states, zero credits, unavailable credits and ambiguous redemption. All fetches are replaced in-page; no live account requests or resets occur. The default compressed rail contains seven OpenAI and two Anthropic accounts at 330px wide, with height tied to the viewport (650px at 1366×768; 602px at 1280×720). Toggle compressed rail for the spacious desktop comparison; tab through controls to scroll lower cards into view. Ambiguous consumption disables that account's reset action across panel remounts. Reload the fixture to clear its test session.
