# Models and connections

Current implementation reviewed **8 November 2026**. [Source coverage](../project/source-map.md) records the exact build and verification limits. Existing commit-linked citations identify historical evidence; they are not links to the current development source.

An agent needs a saved model connection and a selected model to answer. A connection tells Burrow which API to call and how to authenticate; the model selector chooses what that agent uses. A provider account, quota, and any model charges are separate from installing Burrow.

## Add an API connection

1. Open **Settings → Connections → Models**.
2. Choose **Add provider** beside the saved-provider inventory, then give the **Provider** a recognizable name.
3. Choose the API contract your endpoint actually supports: **OpenAI Chat Completions**, **OpenAI Responses**, **Anthropic Messages**, or **Google Gemini (Developer API)**.
4. Enter the provider's **URL** and **API key**. Use the endpoint supplied by that provider; an OpenAI-compatible service is not necessarily the OpenAI service.
5. Select **Connect** to discover models. Review the results and select the models you want available.
6. Select **Save**. Connecting and saving are separate steps.
7. Return to **Chat**, select the intended agent, then choose its **Provider** and **Model**. Send a small text-only test before trying tools or media generation.

Checked **3 November 2026**: the Models workspace keeps saved providers on the left, with the selected connection, compact model list and model capabilities in the remaining space. Selecting a model row opens its details; its checkbox independently controls whether that model is enabled for direct selection.

If discovery fails, read the displayed error. The editor allows adding model IDs manually; use the provider's exact ID. A manual entry makes a model selectable but does not prove the endpoint or your account can run it. A saved connection needs at least one selected model.

[Source: connection editor](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/ui/src/features/settings/ModelConnections.tsx) · [discovery, save, and manual models](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/ui/src/features/settings/useModelConnectionEditor.ts).

## Account sign-in options

The UI includes **OpenAI OAuth → Sign in with ChatGPT** and **Anthropic OAuth → Claude Code login**. These are distinct from entering a provider API key.

- For ChatGPT, start the sign-in, open the authorization URL, and finish in your browser. If prompted, paste the callback code or redirect URL into Burrow's **Callback code or URL** field and choose **Submit callback**. Wait for **Signed in**, review the discovered models, and click **Save** to save the model selection.
- For Anthropic, choose **Start Claude Code login**, finish the browser step, submit the callback code when requested, then use **Import Claude auth** when available. The flow can create its connection when needed; the dialog's older save-first note is not a prerequisite in this release.
- If a login expires or fails, use its displayed error and restart deliberately. Closing the dialog is not evidence of successful authorization.

Treat callback URLs, codes, and tokens as secrets. Enter them only into the sign-in flow you started, not into an agent conversation or bug report. Provider eligibility and policies can change; the presence of a sign-in button is not a promise of account access.

[Source: sign-in dialogs and statuses](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/ui/src/features/settings/ModelConnectionOAuthDialog.tsx).

## OAuth refresh and cancellation

Current Core shares in-flight credential resolution per connection. Stopping a run cancels that caller's wait, not a refresh exchange that may already have consumed a single-use token. The exchange has its own 15-second network deadline and finishes response reading and encrypted persistence independently. PostgreSQL advisory locking coordinates refreshes across store instances; normal shutdown drains credential work before closing the pool.

A concurrent operator credential replacement is re-read before returning an obsolete failure. A successful rotation cannot overwrite a different replacement refresh token. For a token-only edit that retains the exchanged refresh token, edited fields are preserved while the lineage advances; account identity remains tied to the selected access token rather than the discarded response.

OpenAI invalid-grant, reused, expired, invalidated and revoked-token failures are classified separately from generic failure or timeout. The latter do not automatically require reauthorization. Independent applications sharing the same token lineage are outside this coordination, and a process crash or transport failure can leave the exchange outcome unknown. This is source-reviewed behavior, not a claim of crash-proof or long-duration live authentication.

## Native OAuth account pools

Use **Settings → Connections → Load Balancing**, separate from **Models**, to create a logical OpenAI or Anthropic OAuth pool.

1. Connect and save the individual same-family OAuth accounts under **Models** first.
2. Open **Load Balancing**, enter **Name**, and choose **Adapter → OpenAI** or **Anthropic**.
3. Select **Member accounts**, leave **Enabled** on when intended, and choose **Save**. The pool editor has no separate API key, URL, login, Connect button, or model checklist.
4. Select the saved logical provider and a model in Chat. Pool models are the **intersection** of the members' discovered catalogs; manual member models do not contribute. Direct-account selection checkboxes do not disable a model for pool routing.

Only matching OAuth accounts can be members: not API-key connections, cross-family accounts, or nested pools. Remove unavailable members before saving. A member cannot be deleted while referenced by a pool. Changing membership does not recreate the pool ID or agent selection.

Saving a pool discovers members whose catalogs are empty. Discovery or catalog failure can reject the pool save; credentials/catalogs refreshed earlier in that operation may already be persisted. Individual OAuth catalogs also refresh at startup and periodically (24 hours). Failed or empty upstream discovery preserves the last good catalog; it is not evidence that all models disappeared. Ordinary connection saves patch their catalog rather than deleting omitted models.

### Routing and continuation limits

Routing checks family, enabled state, model presence, usage freshness, capacity and cooldowns. Unknown usage is not invented spare quota. Checked **6 November 2026**: sticky ownership stays preferred while eligible; the former 25/10-point imbalance rules no longer move a healthy owner. An actual provider-declared five-hour window becomes ineligible at **95% used / 5% remaining**, inclusively. Weekly or unknown-duration windows do not acquire an invented five-hour threshold. Exhaustion, provider blocking and persisted cooldown also prevent required-account continuations from dispatching. Successful alternate service promotes the new owner; a failed attempt does not. The UI exposes no manual weights or account selector.

There is at most one alternate pre-output attempt for eligible availability failures. A native tool continuation can switch only when Core proves the complete submitted text/tool history is portable and unchanged. Signed thinking, account-bound images/files, missing replay proof, cancellation, or prior visible output prevent this replay. Account-bound continuation state is never copied between accounts. A pool therefore does not guarantee seamless failover. Forge media uses a separate dispatch path and is not pooled by this text-model feature.

### Read the bottom-row OpenAI LB statistics

The footer shows **OpenAI LB** with rolling **24h** and **7d** windows, refreshed about every 30 seconds. These statistics cover native OpenAI pools only—not Anthropic pools, direct accounts, or the retired external Codex-LB integration.

- **Requests:** logical completed adapter requests. A retry adds an attempt, not another request; continuation calls count as their own logical requests.
- **Tokens:** known input plus output across all attempts, including retries. Cached tokens are already included in input; do not add them again. The tooltip identifies partial token reporting.
- **Prompt cached:** cached/input percentage only for attempts reporting both counts. Hover or focus for coverage; missing usage is not zero.
- **Errors:** final failed requests divided by completed requests. Successful failover is success; cancellations enter the denominator but not the failure numerator.

A dash means unavailable/unknown, not zero. Requests interrupted by process death before durable finalization remain unfinished and are excluded from completed windows. Metrics survive restart/account deletion and are not a billing statement. [Observability](../operations/observability.md#native-openai-pool-metrics) explains API/OTel scope.

### Native OpenAI reset credits

The **Accounts** panel can display provider-reported banked resets for an individual OpenAI OAuth account. **Use reset** refreshes availability and asks for confirmation before consuming one; it is not automatic pool balancing. A reset is irreversible and provider-dependent. If the outcome is unknown, do not repeatedly retry or bypass the locked control: verify account usage/reset history first. A successful reset and a failed subsequent usage refresh are different results. Missing status is unknown, not proof of exhaustion or available credit.

## Capabilities and context size

Selecting a model opens its details. The editor distinguishes discovered capabilities from manual overrides:

- **Input:** text and image
- **Output:** text, audio, image, video, and file
- **Context window:** Auto or a positive manual token limit
- **Output token limit:** displayed provider metadata

Keep **Auto** unless you have reliable information for the exact model and endpoint. Turning on an output checkbox does not add an adapter, enable a provider feature, or grant access to a model. Similarly, a larger manual context limit does not increase the provider's actual limit.

In Chat, **Effort** and **Temp** adjust the selected agent's model settings where supported. Available effort choices depend on the connection/model; controls are locked while the displayed run is active. The context tooltip distinguishes request estimates from provider-reported response input; see [context meter labels](../concepts/interface.md#read-the-context-meter). It is not a billing statement or proof that execution succeeded.

[Source: model capabilities and context controls](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/ui/src/features/settings/ModelConnectionViews.tsx) · [Chat controls](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/ui/src/features/chat/ChatPage.tsx).

## Anthropic thinking and effort

For native Anthropic connections and pools, **Thinking** and **Effort** are independent controls. Available choices follow the selected model's capabilities:

- **Default** thinking lets the provider choose; it does not mean Disabled.
- **Disabled** explicitly disables thinking only where supported.
- **Adaptive** uses adaptive thinking. **No up-front thinking** uses between-tools thinking when available.
- **Manual** uses legacy budgeted thinking on models that support it. Effort is not silently converted into a manual token budget.
- **Default** effort omits an explicit native effort choice; it does not turn thinking off.

Older saved selections can display a **Legacy** mode. They retain their earlier effort-based behavior instead of silently becoming provider default. Legacy Off resolves to Disabled, so a model that cannot disable thinking needs an explicit supported mode before it can run. Resolve the displayed validation issue deliberately; unavailable choices are not automatically replaced. Settings are retained for the complete turn and its tool continuations. See [model behavior](../concepts/models.md) for compatibility details.

Anthropic discovery follows all catalog pages. Advertised native capabilities take precedence over known-model fallbacks, including explicit unsupported values. An incomplete or failed refresh preserves the last good catalog; it must not be interpreted as the model being removed. A manual model ID still does not prove support or account access.

## Change or remove a connection

Open the saved provider in **Settings → Connections → Models**, choose **Edit connection** to reveal its setup fields, edit its settings, and save again. New providers keep those fields visible. A failed Connect keeps recovery fields open until Connect succeeds or you switch providers; inspect the error rather than treating Save or a visible catalog as proof of a recovered connection. The API-key field indicates when a key is already configured. Follow its replacement prompt rather than pasting secrets into unrelated fields.

Deleting a provider removes its saved connection. Check which agents use it first; they may need a replacement provider/model selection. If a model disappears after a change, recheck the connection's selected models and the agent's selection before creating a duplicate connection.

For authentication errors, connection failures, and safe diagnostics, see [Updates, backups, and help](maintenance.md).

## Explicit model selection after API discovery

For ordinary API-key connections, newly discovered model IDs start unchecked. Select at least one before saving; rediscovery preserves existing selections and leaves newly found IDs unchecked. OAuth and Load Balancing discovery retain their existing behavior. This editor opt-in does not redefine pool catalog intersections or disable pool routing through an account checkbox.

Provider quota indicators and their polling were removed from the bottom status bar. OpenAI LB aggregate request/token statistics remain a separate feature; this UI removal does not disable provider-pool capacity routing.

## Saved connections for mod-owned agents

Checked **5 November 2026**: a saved connection ID is authoritative even if that connection is unavailable. A mod-owned resident does not silently use the first configured provider or its first model. Before sending, choose an available provider and enabled model for that resident. If the saved connection/model cannot be resolved, Chat reports the problem without submitting the turn. Changing the provider deliberately replaces the old connection identity; failed selection saves remain errors rather than successful changes.

For background embeddings, use the separate controls under **Settings → General → Continuity**, described in [Skills and memory](skills-and-memory.md#optional-embeddings). A working chat model does not by itself establish embedding support.

## Quota recovery timing

An eligible alternate may serve immediately after a 429 even if the failed account has a longer `Retry-After`. That deadline applies to the failed account's durable health window, not every pool member. A proven portable continuation can switch before dispatch when its old owner is unavailable; signed/nonportable state must remain on its required account and stops if that account cannot serve. When no alternate is eligible, managed recovery waits only for a known short availability deadline within its 30-second cap. A longer or unknown deadline stops live recovery rather than repeatedly probing or keeping the turn waiting for a long quota reset. Keep the original provider error separate from the failover blocker.

### Automatically use expiring resets

Checked **7 November 2026**: expand a direct OpenAI OAuth connection's settings to enable **Automatically use expiring resets**, then save the connection. It is off by default and is not offered on logical load-balancing pools. Once saved, the backend checks at startup and every minute, even with the browser closed, for available credits expiring within ten minutes. Manual resets remain available. Enabling this authorizes automatic consumption of eligible banked credits; a consumed reset cannot be undone.

Each attempt pins the account, exact credit and expiry. Confirmed `nothing_to_reset` or a definite rejection can retry that same available, unexpired credit after a one-minute cooldown. It does not silently substitute another credit. Unknown outcomes fence the account across aliases and restarts. A later exact redeemed record with a redemption timestamp can reconcile the attempt; disappearance, expiry or a stale available listing is not proof of success. Do not bypass the fence or repeatedly click reset. Successful consumption is recorded separately from a subsequent usage-refresh failure.
