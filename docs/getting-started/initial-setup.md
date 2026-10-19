# Initial setup

!!! warning "Earlier technical reference"
    This page is retained from earlier documentation and has not been fully revalidated for the public 2026.10.19 release. Its revision-specific links and examples may describe older or development behavior. Start with the [current public-release user guide](../guide/installation.md); do not use this page alone to select installation commands, image tags, or security settings.

Complete setup from the local listener before exposing Burrow to other machines. Keep [authentication](../security/authentication.md) and the [settings encryption key](../reference/configuration.md) under operator control.

## First-run flow

The UI reads `/api/setup/status`. A `fresh` or `incomplete` installation opens **Settings → Agents** and the first-run dialog. The dialog has five stages:

1. Import an existing portable export, or start fresh
2. Enter the operator's displayed name and optional avatar
3. Choose the first agent's name and optional avatar
4. Write its personality/identity text for the `SOUL` profile document
5. Select a saved connection and model, use the OpenAI/Anthropic OAuth shortcut, or leave the model unselected and choose **Skip / Finish**

An import can replace conflicting portable records. Only use an export you trust, and review [export versus full backup](../operations/backup-recovery.md#portable-exports) before choosing that path.

Setup completion is based on persisted records: a nonempty operator name and at least one named agent. A model is optional for completing setup, but is needed for model-backed chat. Once completion is persisted, deleting the last agent does not automatically turn the installation back into a fresh setup.

The current wizard submits all six profile kinds: `SOUL`, `RULES`, `ORIENTATION`, `PREFERENCES`, `TOOLS`, and `DREAM_MEMORY`. `/api/setup/operation` commits identity, agent, profiles, completion and its replay record together in one PostgreSQL transaction.

!!! note "Recovering the historical 2026.10.10.4 profile error"
    That wizard omitted `PREFERENCES` and could fail with `agent_profile_documents_complete_set_required`. The current UI repairs its known retained five-document submission by adding empty `PREFERENCES` and saving the repaired payload in this browser before sending. It preserves the operation ID, existing text and all other input. Failed profile validation does not commit that operation. Older installations may have partial records; use the [targeted recovery procedure](../operations/troubleshooting.md#first-run-profile-error) rather than assuming an agent exists or changing its name repeatedly.

For a lost response or transient error, retry in the same browser to recover the original submission. Complete six-document submissions are replayed unchanged: do not clear browser storage or change a committed operation's input. If saving the legacy repair to browser storage fails, no request is sent; restore storage access and retry. OAuth connections created separately are outside the setup transaction.

## Configure a usable model

1. Open **Settings → Connections → Model providers**. Under **Models**, enter a recognizable **Provider** label, choose **API type**, and enter the provider's **URL** and **API key**. Use distinct provider labels: the current Chat dropdown selects by label even though the backend stores durable connection IDs.
2. Choose **Connect** to discover models. This populates the editor; it is not the final **Save** step. If discovery fails or returns none, enter an exact provider-supported **Model ID** and choose **Add model**.
3. Check **Use …** for every model you want available. Click a model's name to inspect **Model details**. **Input**, **Output**, and **Context window** each have **Auto** and **Manual** modes. Keep Auto unless you have reliable provider information; an override does not add a capability the provider lacks.
4. Choose **Save**, then verify the connection appears among saved providers. To edit one, select its card. A blank API-key field on an existing connection preserves the configured key; entering a new key replaces it.
5. Open **Chat**, select the intended agent, and choose **Provider** and **Model** in the toolbar. Adjust **Effort** or **Temp** only as supported by the model. These controls save the agent's selection; they are not merely one-turn overrides. **Agent details** edits the agent's identity and enabled state, not its model.
6. Reload and run the short conversation check below. A saved connection, an enabled model, and an agent selection are separate pieces of configuration.

### OpenAI: API key or ChatGPT sign-in

For an OpenAI API-key connection, choose the supported OpenAI API type and use the public API base URL `https://api.openai.com/v1`, then follow Connect, model selection and Save above. This is separate from signing in with a ChatGPT account.

For the built-in account flow, choose **OpenAI OAuth → Sign in with ChatGPT**. Open the displayed authorization URL, complete sign-in, and let the dialog poll. If the callback is not received automatically, paste the callback code or redirect URL into **Callback code or URL** and choose **Submit callback**. Use **Cancel login** when abandoning an active flow. Closing the dialog is not the same as cancelling the login.

Successful authorization supplies the connection's API type and backend URL and starts discovery. Keep those supplied values. If authorization succeeds but discovery fails, close the dialog, use the retained connection editor to add a supported Model ID manually, select it, and choose Save. Do not paste a ChatGPT token into an unrelated provider's API-key field. Finish by selecting that saved provider/model in Chat.

Keep credentials out of profile text, screenshots, shell history, and shared logs. See [models](../concepts/models.md) for adapter and cache behavior.

## Review agent context

The regular profile editor exposes `SOUL`, `RULES`, `ORIENTATION`, `PREFERENCES`, `TOOLS`, and `DREAM_MEMORY`. These are PostgreSQL-backed profile records rendered as document-like context, not ordinary files that must be edited in the application tree.

Set an explicit agent identity and useful instructions. Avoid copying private host-specific paths or credentials into reusable profiles. Review [agents and minions](../concepts/agents-minions.md) and [memory](../concepts/memory.md) to understand what persists and what enters the next model request.

## Set operating preferences

- **Settings → General → Operator timezone:** choose the intended IANA timezone; inherited schedules follow it
- **Settings → Connections → Authentication:** configure the chosen authentication mode before remote access
- **Settings → Connections → MCP servers:** add only required integrations; assign permitted tools to the intended agent
- **Settings → General → Trace retention:** review retention and preview cleanup before destructive maintenance

Dream cycles and other background work can call providers after setup. Review agent Dream settings and scheduled jobs, especially on metered model accounts. See [Dreams](../concepts/dreams.md) and [workers and tasks](../concepts/workers-tasks.md).

## Verify one conversation

1. Open **Chat** and select the intended agent
2. Send a short, low-risk question
3. Confirm a complete answer arrives, with the expected model selected
4. Inspect the activity or [observability](../operations/observability.md) if a tool or model call fails
5. Reload the UI and confirm the conversation and selected runtime are still correct

A provider error, missing model selection, or incomplete stream is a failed verification even if the HTTP request itself returned 200. Do not grant broad tool access merely to make a basic chat test pass.

The main UI also has **Tasks**, **Archive**, **Brains**, **Forge**, and **Settings**. See the [interface guide](../concepts/interface.md) for their roles.

## Source evidence

-  and 
-  and 

