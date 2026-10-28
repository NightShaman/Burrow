<div class="burrow-hero" markdown>

![Burrow](assets/hero.png){ .burrow-hero-logo }

# Your agents. Your workbench.

Burrow is a self-hosted, chat-first AI agent application. Connect a model, give an agent a personality, and keep conversations, tools, memories, and project work in one place.

[Install Burrow](guide/installation.md){ .md-button .md-button--primary }
[Create your first agent](guide/first-agent.md){ .md-button }

Operator guide · **current implementation reviewed 26 October 2026**

</div>

!!! danger "Burrow is not safe by design."
    Burrow gives agents real tools and real access. Depending on what you enable, they can run commands, change or delete files, use credentials, and affect connected systems. Models make mistakes. **Burrow is not a sandbox; you are responsible for the access you grant and the consequences.**

## Start small. Add what you need.

You run Burrow on your own host and open its web interface in a browser. Model providers and integrations may still receive the content you send them; self-hosted does not mean every model runs locally.

<div class="grid cards" markdown>

- **Have your first conversation**

    Install Burrow, finish the setup wizard, connect a model, and send a harmless first message.

    [Start here →](guide/installation.md)

- **Make it your everyday workspace**

    Switch agents and sessions, follow running work, use files, and find past conversations.

    [Learn the interface →](guide/everyday-use.md)

- **Give agents useful capabilities**

    Understand model connections, MCP tools, Node Goblin, skills, and optional mods before enabling them.

    [Choose tools and mods →](guide/tools-and-mods.md)

- **Keep your work safe**

    Update deliberately, protect your database and encryption key, and know what to check when something fails.

    [Maintenance and help →](guide/maintenance.md)

</div>


## A guide to current implementation

These user guides follow inspected current Core implementation, without waiting for the daily public-source sync. The reviewed assembly is **2026.10.28.8**; [source coverage](project/source-map.md) records exact revisions and historical boundaries. Features depend on your installed version, provider, and enabled mods. A documentation update does not upgrade your installation.

Older architectural and API material remains under **Earlier technical reference**, with historical warnings where applicable. It is not a second set of current installation instructions. [Read the source and verification scope](project/source-map.md).

Burrow is distributed under its [Sustainable Use License](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/LICENSE).

