# Build and maintain the documentation

The documentation lives in the public assembled repository. It uses MkDocs Material, pinned Python dependencies, strict Markdown link validation, a generated-HTML link checker, and browser-based Mermaid rendering tests.

## Local preview

Use Python 3.12, the same version as documentation CI. From the repository root:

```sh
python3 -m venv .venv-docs
. .venv-docs/bin/activate
python -m pip install -r requirements-docs.txt
python -m mkdocs serve --dev-addr 127.0.0.1:8000
```

Open `http://127.0.0.1:8000/`. On Windows PowerShell, activate with `.venv-docs\Scripts\Activate.ps1` instead of the POSIX activation command.

No BURROW runtime, provider account, PostgreSQL instance, private source credential, or application dependency installation is needed to build this site.

## Required checks

```sh
python -m mkdocs build --strict
python scripts/docs/check_site.py site
python -m pip install -r requirements-docs-test.txt
python -m playwright install chromium
python scripts/docs/check_mermaid.py site
```

For an existing Chromium installation, set `DOCS_CHROMIUM_EXECUTABLE` to its executable path before the rendering check. This is a documentation-test override, not a BURROW runtime variable.

On Linux systems missing browser libraries, Playwright's `python -m playwright install --with-deps chromium` also installs OS prerequisites and may require administrative privileges. CI uses this option on its disposable runner.

- **Strict build:** fails on configuration, missing navigation pages, unlisted pages, broken Markdown targets, and missing anchors.
- **HTML check:** traverses every built HTML file and checks local links, anchors, and referenced assets, including the GitHub Pages `/Burrow/` base path.
- **Mermaid check:** serves the built site on loopback, opens every diagram-bearing page in Chromium, requires generated SVG diagrams, and fails on JavaScript or Mermaid errors. A code block alone is not a rendering pass.

Material loads Mermaid from its configured distribution when rendering diagrams. Browser checks therefore need network access to the Mermaid CDN as well as the local test server. A network-blocked test must be reported as blocked, not passed. The ordinary Python build does not render diagrams.

## GitHub Pages

The dedicated [Documentation workflow](https://github.com/NightShaman/Burrow/blob/main/.github/workflows/docs.yml) builds on documentation pull requests and documentation changes pushed to `main`. It can also be run manually.

1. In repository **Settings → Pages**, select **GitHub Actions** as the deployment source.
2. Review repository/environment access and any required `github-pages` approvals before publishing.
3. Merge the reviewed documentation changes to `main` or run the workflow manually from `main`.
4. Check both the build and deployment jobs. A successful artifact upload is not a successful Pages deployment.
5. Open the workflow's deployment URL and verify the expected content.

The configured project-site URL is `https://nightshaman.github.io/Burrow/`. It is a deployment target, not a statement that the site is currently live. A custom domain or different repository name requires updating `site_url` and the HTML checker's `--base-path` argument together.

Pull requests only build and upload a review artifact. Deployment uses a separate job with `pages: write` and `id-token: write`; application/container publishing permissions and private-source tokens are not needed. Repository or organization settings may still prevent Pages publication.

!!! warning "Public documentation"
    This repository is public. Do not include credentials, real operator environments, private transcripts, personal paths, or sensitive deployment details in examples. Use fictional placeholders and source-backed defaults.

## Source ownership

The assembly workflow replaces application payloads and the root README from upstream sources. It preserves root `docs/`, `mkdocs.yml`, documentation dependency files, `scripts/docs/`, and the separate documentation workflow. Do not put hand-maintained documentation inside generated `backend/` or `ui/` directories.

A README change made only in this public repository will be overwritten by assembly. For a permanent root README link, update its Backend deployment source through the normal source-repository process. This documentation change intentionally leaves that generated file alone.

The site documents a pinned source baseline, shown in [Source and coverage](../project/source-map.md). The workflow does not pretend to regenerate architectural prose automatically when application code changes. Before changing that baseline, inspect source differences and update affected pages and reference inventories.

## Writing conventions

- Explain operator/developer behavior before listing implementation files.
- Keep one main topic per page; use relative `.md` links so MkDocs validates them.
- Use actual commands and exact option names from source. Distinguish installed launcher commands from direct source CLI commands.
- Label compatibility, experimental, incomplete, inferred, and source-visible untested behavior.
- Add a warning where a procedure can destroy data, expose a listener, modify schema, or lose encrypted settings.
- Link substantial claims to the documented public commit. Prefer public equivalents over private upstream links.
- Keep configuration and environment defaults in their references and cross-link them from guides.
- Check the [known limitations](../project/known-limitations.md) before promising a feature works end-to-end.

## Diagrams

Use fenced `mermaid` blocks for relationships, sequence diagrams, and trust boundaries. `mkdocs.yml` configures Material's native Mermaid integration through SuperFences; no second Mermaid plugin or custom loader is necessary.

Prefer quoted node labels, short identifiers, and diagrams that remain readable on a narrow screen. Test every new or changed diagram with `check_mermaid.py`. Avoid embedding real deployment addresses or secrets in diagram labels.

## Reproducible dependencies

`requirements-docs.txt` pins the complete resolved static-build dependency set. `requirements-docs-test.txt` pins the browser test package separately. Refresh these intentionally in an isolated environment and rerun the strict build, local-link check, and rendering check before merging.

See [MkDocs validation configuration](https://www.mkdocs.org/user-guide/configuration/#validation) and [Material diagrams](https://squidfunk.github.io/mkdocs-material/reference/diagrams/) for upstream tooling behavior.
