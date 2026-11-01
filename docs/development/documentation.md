# Build this documentation

This shared documentation site uses Docusaurus. Its source is GoblinKing-Burrow/Docs-Website, with project guides in `docs/`, navigation in `sidebars.json`, and site settings in `docusaurus.config.js`. A build does not require Burrow application dependencies, a running server, a database, or model credentials.

## Preview locally

From the Docs-Website repository root, use Node.js 22 or newer:

```sh
npm ci
npm start
```

Open the local URL printed by Docusaurus. To validate and preview the production output:

```sh
npm run build
npm run serve
```

Output is written to `build/`. Broken local links and missing Markdown assets fail the build. Search is indexed locally during the production build. Mermaid diagrams are bundled with the site; inspect their browser rendering and check both desktop and phone layouts after changing diagrams or styles.

## Maintain the source

Edit `docs/<project>/` and preserve project-specific artwork. Use `.md` for CommonMark and `.mdx` for React components. Use Docusaurus admonitions such as `:::danger` and `:::warning`; MkDocs `!!!` blocks are not supported. Update `sidebars.json` when adding or moving a guide.

Use current inspected development implementation as the documentation baseline rather than waiting for public mirrors. State which behavior requires a newer source snapshot, distinguish it from installed/tagged public versions, and record exact source pins. Do not mechanically repoint old source citations to a new commit without checking their claims. Keep prominent risk warnings and historical-reference labels intact.

## Publishing the documentation

The canonical site is [docs.goblin-kingdom.com](https://docs.goblin-kingdom.com/), with project routes including `/burrow/`, `/node-goblin/`, `/burrow-backdoor/`, `/goblin-secret-store/`, `/burrow-switchboard/`, `/burrow-theater/`, `/burrow-tutor/`, and `/burrow-skills/`. The configured base path is `/`.

In **GoblinKing-Burrow/Docs-Website**, `.github/workflows/deploy.yml` builds pull requests and deploys successful builds from `main` using the GitHub Pages artifact flow. Deployments use narrowly scoped `pages: write` and `id-token: write` permissions and the `github-pages` environment. No application images are built or published.

The custom domain is already the canonical publication target. Ordinary documentation maintenance does not require changing Pages settings, domain bindings or DNS. The repository owner manages those settings separately. A `static/CNAME` file does not itself change DNS or Pages settings. A private repository requires a plan that supports Pages for private repositories; the website may be public even when its source repository is private.

Before publication:

1. Review the documentation changes and run the production build.
2. Check rendered links, screenshots, warnings, diagrams, and narrow-screen navigation.
3. Confirm the deployment job succeeded, then verify the live homepage, project guides, images, and canonical URLs.

Where maintained, original project repositories retain their own documentation source and workflows. Commands for those sites do not build this shared Docusaurus site.

No credentials, real operator data, private transcripts, or secret-bearing screenshots belong in this public site.

## Updating the guide

Use concrete UI labels, small safe examples, and links to immutable public source. Distinguish installed, enabled, connected, accepted, running, and completed states. Record verification limits in [Source and coverage](../project/source-map.md). Retained historical pages must stay visibly marked until their claims have been checked against the current implementation baseline.


For upstream documentation-only maintenance, use `[skip ci]` commits where needed to avoid application/release workflows; do not skip this website’s deployment build. Ordinary runs reconcile drift since the last successful receipt; Sunday reviews cover every documented page, including unchanged topics. Retain source pins, page-level coverage and deployment/live receipts for the next run.

## Validate upstream copies as well as this site

When synchronizing a guide into an owning repository, copy or verify every referenced local image, download and linked page at that repository's final paths. A successful consolidated build does not prove the upstream documentation is self-contained. Compare asset hashes where the same illustration is shared, and preserve that repository's Markdown/admonition conventions instead of copying Docusaurus syntax into MkDocs.

For Burrow's upstream MkDocs tree, run its documented docs-only dependency setup and `mkdocs build --strict` from the repository root. Also check rendered internal links/fragments and referenced assets. Do not run application/provider tests to validate documentation. Upstream `[skip ci]` avoids runtime/release workflows; it does not excuse skipping safe local documentation checks. Keep the upstream commit, asset check, build result, consolidated deployment and live-page verification in the maintenance receipt.
