# Build this documentation

This is a hand-written MkDocs Material site. Its sources are `docs/`, `mkdocs.yml`, `requirements-docs.txt`, and `scripts/docs/`. Building it does not require a running Burrow instance, database, model account, or application dependencies.

## Preview locally

From the repository root, with Python 3.12:

```sh
python3 -m venv .venv-docs
. .venv-docs/bin/activate
python -m pip install -r requirements-docs.txt
python -m mkdocs serve --dev-addr 127.0.0.1:8000
```

Open `http://127.0.0.1:8000/`. Windows PowerShell uses `.venv-docs\Scripts\Activate.ps1` for activation.

## Validate the site

```sh
python -m mkdocs build --strict
python scripts/docs/check_site.py site --base-path /
```

The strict build validates configuration, navigation, Markdown links, and anchors. The HTML checker validates built local links, assets, and fragments. The custom-domain site uses the root path `/`, without `/Burrow/`. Keep `site_url` and the checker base path aligned.

The retained technical reference includes Mermaid diagrams. Check actual browser rendering separately:

```sh
python -m pip install -r requirements-docs-test.txt
python -m playwright install chromium
python scripts/docs/check_mermaid.py site --artifacts docs-browser-artifacts
```

Set `DOCS_CHROMIUM_EXECUTABLE` to an existing Chromium executable if needed. Diagram rendering requires its external Mermaid distribution to be reachable. A failed network request is a blocked render check, not a pass. Check the homepage and user-guide layout at desktop and phone widths as well.

## Maintain the source

Edit the hand-written documentation in `docs/` and its build configuration in `mkdocs.yml`. Product instructions should describe an inspected public release. Do not mechanically repoint old source citations to a new commit without checking their claims.

## Publishing the documentation

The canonical URL is `https://burrow-docs.blissful-psychosis.com/`, without a `/Burrow/` path. GitHub Pages owns the custom-domain binding; the DNS CNAME points `burrow-docs` to `GoblinKing-Burrow.github.io`. This source configuration does not itself change DNS or Pages settings. Build output is in `site/`.

The Documentation workflow builds and checks the site. In **GoblinKing-Burrow/Burrow**, after successful checks on `main`, it uploads the static `site/` directory and deploys to that repository’s configured GitHub Pages site. Pull requests run checks only. This workflow does not build or publish Burrow application images.

The deploy job has narrowly scoped `pages: write` and `id-token: write` permissions and uses the `github-pages` environment. Hosting and custom-domain settings are managed separately. The workflow reads existing Pages settings with automatic enablement disabled; an unconfigured Pages site must be configured by its owner before deployment can succeed. Do not assume that a successful build or an uploaded artifact updates the website: verify the deployment job and live URL.

Before publication:

1. Review the documentation source changes.
2. Run the static and browser checks against the final files.
3. Confirm the existing host and custom-domain settings without changing DNS unnecessarily.
4. Publish through the approved host, then verify its homepage, guide pages, assets, and canonical URLs.

No credentials, real operator data, private transcripts, or secret-bearing screenshots belong in this public site.

## Updating the guide

Use concrete UI labels, small safe examples, and links to immutable public source. Distinguish installed, enabled, connected, accepted, running, and completed states. Record verification limits in [Source and coverage](../project/source-map.md). Retained historical pages must stay visibly marked until their claims have been checked against a new public baseline.
