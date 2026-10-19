export function nextDevelopmentVersion({ date, currentVersion = '' } = {}) {
  const buildDate = String(date || '').trim();
  if (!/^\d{4}\.\d{2}\.\d{2}$/.test(buildDate)) throw new Error('development_build_date_invalid');
  const match = String(currentVersion || '').trim().match(new RegExp(`^${buildDate.replaceAll('.', '\\.')}\\.(\\d+)$`));
  return `${buildDate}.${match ? Number(match[1]) + 1 : 1}`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.stdout.write(`${nextDevelopmentVersion({ date: process.argv[2], currentVersion: process.argv[3] })}\n`);
}
