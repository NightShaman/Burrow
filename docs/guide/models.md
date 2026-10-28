# Models and connections

Current implementation reviewed **26 October 2026**. [Source coverage](../project/source-map.md) records the exact build and verification limits. Existing commit-linked citations identify historical evidence; they are not links to the current development source.

An agent needs a saved model connection and a selected model to answer. A connection tells Burrow which API to call and how to authenticate; the model selector chooses what that agent uses. A provider account, quota, and any model charges are separate from installing Burrow.

## Add an API connection

1. Open **Settings → Connections → Models**.
2. In the **Models** form, give the **Provider** a recognizable name.
3. Choose the API contract your endpoint actually supports: **OpenAI Chat Completions**, **OpenAI Responses**, **Anthropic Messages**, or **Google Gemini (Developer API)**.
4. Enter the provider's **URL** and **API key**. Use the endpoint supplied by that provider; an OpenAI-compatible service is not necessarily the OpenAI service.
5. Select **Connect** to discover models. Review the results and select the models you want available.
6. Select **Save**. Connecting and saving are separate steps.
7. Return to **Chat**, select the intended agent, then choose its **Provider** and **Model**. Send a small text-only test before trying tools or media generation.

If discovery fails, read the displayed error. The editor allows adding model IDs manually; use the provider's exact ID. A manual entry makes a model selectable but does not prove the endpoint or your account can run it. A saved connection needs at least one selected model.

[Source: connection editor](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/ui/src/features/settings/ModelConnections.tsx) · [discovery, save, and manual models](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/ui/src/features/settings/useModelConnectionEditor.ts).

## Account sign-in options

The UI includes **OpenAI OAuth → Sign in with ChatGPT** and **Anthropic OAuth → Claude Code login**. These are distinct from entering a provider API key.

- For ChatGPT, start the sign-in, open the authorization URL, and finish in your browser. If prompted, paste the callback code or redirect URL into Burrow's **Callback code or URL** field and choose **Submit callback**. Wait for **Signed in**, review the discovered models, and click **Save** to save the model selection.
- For Anthropic, choose **Start Claude Code login**, finish the browser step, submit the callback code when requested, then use **Import Claude auth** when available. The flow can create its connection when needed; the dialog's older save-first note is not a prerequisite in this release.
- If a login expires or fails, use its displayed error and restart deliberately. Closing the dialog is not evidence of successful authorization.

Treat callback URLs, codes, and tokens as secrets. Enter them only into the sign-in flow you started, not into an agent conversation or bug report. Provider eligibility and policies can change; the presence of a sign-in button is not a promise of account access.

[Source: sign-in dialogs and statuses](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/ui/src/features/settings/ModelConnectionOAuthDialog.tsx).

## Native OAuth account pools

Use **Settings → Connections → Load Balancing**, separate from **Model providers**, to create a logical OpenAI or Anthropic OAuth pool.

1. Connect and save the individual same-family OAuth accounts under **Model providers** first.
2. Open **Load Balancing**, enter **Name**, and choose **Adapter → OpenAI** or **Anthropic**.
3. Select **Member accounts**, leave **Enabled** on when intended, and choose **Save**. The pool editor has no separate API key, URL, login, Connect button, or model checklist.
4. Select the saved logical provider and a model in Chat. Pool models are the **intersection** of the members' discovered catalogs; manual member models do not contribute. Direct-account selection checkboxes do not disable a model for pool routing.

Only matching OAuth accounts can be members: not API-key connections, cross-family accounts, or nested pools. Remove unavailable members before saving. A member cannot be deleted while referenced by a pool. Changing membership does not recreate the pool ID or agent selection.

Saving a pool discovers members whose catalogs are empty. Discovery or catalog failure can reject the pool save; credentials/catalogs refreshed earlier in that operation may already be persisted. Individual OAuth catalogs also refresh at startup and periodically (24 hours). Failed or empty upstream discovery preserves the last good catalog; it is not evidence that all models disappeared. Ordinary connection saves patch their catalog rather than deleting omitted models.

### Routing and continuation limits

New-request routing checks family, enabled state, model presence, usage freshness, capacity and cooldowns. Unknown usage is not invented spare quota. A proven continuation can remain with its required owner through advisory telemetry/cooldown failures; removal, explicit disablement and failed credential/member resolution still prevent service. Sticky ownership can yield to a healthier eligible account on a new/unpinned turn: a 25-percentage-point headroom advantage, or 10 points when the sticky account has at most 20% remaining. Successful alternate service promotes the new owner; a failed attempt does not. The UI exposes no manual weights or account selector.

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

In Chat, **Effort** and **Temp** adjust the selected agent's model settings where supported. Available effort choices depend on the connection/model; controls are locked while the displayed run is active. The context display is an estimate, not an exact tokenizer or billing statement.

[Source: model capabilities and context controls](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/ui/src/features/settings/ModelConnectionViews.tsx) · [Chat controls](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/ui/src/features/chat/ChatPage.tsx).

## Change or remove a connection

Open the saved provider in Connections, edit its settings, and save again. The API-key field indicates when a key is already configured. Follow its replacement prompt rather than pasting secrets into unrelated fields.

Deleting a provider removes its saved connection. Check which agents use it first; they may need a replacement provider/model selection. If a model disappears after a change, recheck the connection's selected models and the agent's selection before creating a duplicate connection.

For authentication errors, connection failures, and safe diagnostics, see [Updates, backups, and help](maintenance.md).

