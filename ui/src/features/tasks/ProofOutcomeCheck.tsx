import type { ArchiveOutcomeCheck, ArchiveVerification } from '../../app/api';

const title = 'Public release';
const labels = { verified: 'Verified', mismatch: 'Mismatch', unverified: 'Unverified' } as const;
const missing = 'Not observed';

export function publicReleaseCheck(item: ArchiveVerification) {
  const check = item.outcomeCheck;
  return check?.kind === 'outcome-check' &&
    check.schemaVersion === 1 &&
    check.verifier === 'github_public_release'
    ? check
    : undefined;
}

// The manifest is additional observed evidence, not the expected image ID.
function identities(check: ArchiveOutcomeCheck) {
  const hasImage = Boolean(
    check.expected.artifact.imageRepository || check.observed.artifact.imageRepository,
  );
  return (
    [
      ['Expected (caller supplied)', check.expected],
      ['Observed', check.observed],
    ] as const
  ).map(([label, identity]) => ({
    label,
    version: identity.version ?? missing,
    fields: [
      ['Repository', identity.repository],
      ['Source tree', identity.artifact.sourceTreeSha ?? missing],
      ...(hasImage
        ? [
            ['Image', identity.artifact.imageRepository ?? missing],
            ['Image ID', identity.artifact.imageId ?? missing],
          ]
        : []),
    ],
  }));
}

function sourceStatus(status: number | null) {
  return status == null ? 'No HTTP response' : `HTTP ${status}`;
}
export function outcomeMarkdown(check: ArchiveOutcomeCheck) {
  return [
    `- **${title}: ${labels[check.status]}** — ${check.reason}`,
    ...identities(check).flatMap(({ label, version, fields }) => [
      `  - ${label}: ${version}`,
      ...fields.map(([name, value]) => `    - ${name}: ${value}`),
    ]),
    ...(check.observed.artifact.manifestDigest
      ? [`  - Observed manifest: ${check.observed.artifact.manifestDigest}`]
      : []),
    `  - Checked: ${check.checkedAt}`,
    ...check.evidenceSources.map(
      (source) =>
        `  - ${source.kind}: ${source.url} (${sourceStatus(source.statusCode)}, ${source.checkedAt})`,
    ),
  ].join('\n');
}

export function ProofOutcomeCheck({ check }: { check: ArchiveOutcomeCheck }) {
  const sourceNames = [
    ...new Set(
      check.evidenceSources.map(({ url, kind }) =>
        URL.canParse(url) ? new URL(url).hostname || kind : kind,
      ),
    ),
  ];
  return (
    <div className="proof-outcome">
      <div className="proof-outcome-heading">
        <b>{title}</b>
        <strong className={`proof-status proof-status-${check.status}`}>
          {labels[check.status]}
        </strong>
      </div>
      <p>{check.reason}</p>
      {identities(check).map(({ label, version, fields }) => (
        <div className="proof-outcome-identity" key={label}>
          <b>{label}</b> <strong>{version}</strong>
          <dl>
            {fields.map(([name, value]) => (
              <div key={name}>
                <dt>{name}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
      <div className="proof-outcome-meta">
        <time dateTime={check.checkedAt}>Checked {new Date(check.checkedAt).toLocaleString()}</time>
        <details className="proof-outcome-sources">
          <summary>
            Evidence sources: {sourceNames.length ? sourceNames.join(', ') : 'None recorded'}
          </summary>
          {check.evidenceSources.map((s, i) => (
            <div key={`${s.url}-${i}`}>
              <b>{s.kind.replaceAll('_', ' ')}</b> · {sourceStatus(s.statusCode)}
              <br />
              {s.url}
              <br />
              <time dateTime={s.checkedAt}>{new Date(s.checkedAt).toLocaleString()}</time>
            </div>
          ))}
          {check.observed.artifact.manifestDigest && (
            <div>
              <b>Observed manifest</b>
              <br />
              {check.observed.artifact.manifestDigest}
            </div>
          )}
        </details>
      </div>
    </div>
  );
}
