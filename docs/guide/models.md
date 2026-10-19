# Models and connections

An agent needs a saved model connection and a selected model to answer. A connection tells Burrow which API to call and how to authenticate; the model selector chooses what that agent uses. A provider account, quota, and any model charges are separate from installing Burrow.

## Add an API connection

1. Open **Settings → Connections → Model providers**.
2. In the **Models** form, give the **Provider** a recognizable name.
3. Choose the API contract your endpoint actually supports: **OpenAI Chat Completions**, **OpenAI Responses**, **Anthropic Messages**, or **Google Gemini (Developer API)**.
4. Enter the provider's **URL** and **API key**. Use the endpoint supplied by that provider; an OpenAI-compatible service is not necessarily the OpenAI service.
5. Select **Connect** to discover models. Review the results and select the models you want available.
6. Select **Save**. Connecting and saving are separate steps.
7. Return to **Chat**, select the intended agent, then choose its **Provider** and **Model**. Send a small text-only test before trying tools or media generation.

If discovery fails, read the displayed error. The editor allows adding model IDs manually; use the provider's exact ID. A manual entry makes a model selectable but does not prove the endpoint or your account can run it. A saved connection needs at least one selected model.

[Source: connection editor](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/ui/src/features/settings/ModelConnections.tsx) · [discovery, save, and manual models](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/ui/src/features/settings/useModelConnectionEditor.ts).

## Account sign-in options

The public UI includes **OpenAI OAuth → Sign in with ChatGPT** and **Anthropic OAuth → Claude Code login**. These are distinct from entering a provider API key.

- For ChatGPT, start the sign-in, open the authorization URL, and finish in your browser. If prompted, paste the callback code or redirect URL into Burrow's **Callback code or URL** field and choose **Submit callback**. Wait for **Signed in**, review the discovered models, and click **Save** to save the model selection.
- For Anthropic, choose **Start Claude Code login**, finish the browser step, submit the callback code when requested, then use **Import Claude auth** when available. The flow can create its connection when needed; the dialog's older save-first note is not a prerequisite in this release.
- If a login expires or fails, use its displayed error and restart deliberately. Closing the dialog is not evidence of successful authorization.

Treat callback URLs, codes, and tokens as secrets. Enter them only into the sign-in flow you started, not into an agent conversation or bug report. Provider eligibility and policies can change; the presence of a sign-in button is not a promise of account access.

[Source: sign-in dialogs and statuses](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/ui/src/features/settings/ModelConnectionOAuthDialog.tsx).

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
