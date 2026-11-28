<p align="center">
  <img src="docs/assets/hero.png" alt="Burrow Plug-ins — Seamless integration. Questionable insertion." width="720" />
</p>

# Burrow Plug-ins

**Seamless integration. Questionable insertion.**

Browse apps, connect accounts through hosted sign-in, and choose which actions each goblin can use.

1. Use the corresponding [Burrow Public release](https://github.com/GoblinKing-Burrow/Burrow/releases) or a compatible newer version. Plug-ins requires Core 2026.11.26.2 or later and a Burrow UI with shared agent selection and draft protection. Add `https://github.com/GoblinKing-Burrow/Burrow-Plug.git` in **Settings → Mods → Mod sources**, refresh, install, and enable Plug-ins.
2. Open **Settings → Plug-ins → Brokers → Add broker**. Enter your Composio consumer API key from the broker’s **AI Clients** setup. Core stores it encrypted. You manage the broker account, quota, and charges.
3. Open **Burrow Plug-ins**, select an app, and choose **Connect**. Complete the hosted sign-in, return to Burrow, and choose **Check sign-in**. The app list shows advertised managed OAuth options by default. Plug-ins checks availability with your selected broker before enabling Connect. Providers can require additional setup or approval.
4. In **Settings → Plug-ins → Agent access**, choose the account, an eligible goblin, and the exact actions to allow. Choose **Save permissions**. New accounts start with no grants. Existing direct connections appear when present and use the same Agent access settings.
5. Use **Disconnect** to revoke local access and request broker-account removal. Retry accounts marked **Removal pending** from Burrow Plug-ins. Revoke the original OAuth grant separately through the provider when needed.

Review each action’s access and possible side effects before granting it. Action results can appear in conversation and Proof history. Broker setup and app availability depend on the connected account and provider.
