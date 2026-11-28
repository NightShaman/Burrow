<p align="center">
  <img src="docs/assets/hero.png" alt="Burrow Auditor — Thorough inspection. No safe words." width="720" />
</p>

# Burrow Auditor

**Thorough inspection. No safe words.**

Run independent investigations against a shared objective and review each runner’s original report in Burrow.

1. Use the corresponding [Burrow Public release](https://github.com/GoblinKing-Burrow/Burrow/releases) or a compatible newer version. The mod requires the Core minion bridge, owner-scoped completion feed, and caller-bound result wait from Core 2026.11.27.3 or later. Add `https://github.com/GoblinKing-Burrow/Burrow-Auditor.git` in **Settings → Mods → Mod sources**, refresh, install, and enable Auditor.
2. Open **Settings → Auditor → Projects**. Add requirements and any reference locations. Choose a discovered execution host and an existing working directory on that host. For Node Goblin discovery, use controller mod 2026.11.26 or compatible newer. Select one or more runners with usable Core model connections or native harnesses and access to the references.
3. Save the project and choose **Run audit** there for a manual run. Agents can submit and track audits with the Auditor tools. Core provisions the [official Auditor skill](https://github.com/GoblinKing-Burrow/Burrow-Skills/blob/main/burrow-auditor/SKILL.md) when the mod loads.
4. Read the original reports and overall verdict in **Archive → Mods → Auditor**. An overall pass requires a pass from every runner. Review split or inconclusive results before relying on the audit.

Auditor supplies independent findings and verdicts, not release approval. Availability does not require an audit; a Fail does not mandate repair or re-audit, and a Pass does not prove readiness. The implementing agent evaluates the evidence under the operator’s chosen requirements.

Auditor uses separate sessions on the selected host with its existing filesystem and external access. Give runners only the access they need. Audit inputs and reports persist in Core, so keep credentials out of requirements, references, and reports.

See the [API contract](docs/api.md).
