import type { ReactNode } from 'react';

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="field">{label}{children}</label>;
}

export function SettingSection({ title, children }: { title: string; children: ReactNode }) {
  return <section className="setting-section"><h2>{title}</h2>{children}</section>;
}
