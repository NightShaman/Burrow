import type { HTMLAttributes, ReactNode } from 'react';

type ConnectionState = 'active' | 'paused' | 'quota-exceeded' | 'reauth-required';

export function AccountCard({
  name,
  subtitle,
  status,
  statusTone = 'active',
  children,
  className = '',
  ...articleProps
}: {
  name: string;
  subtitle?: ReactNode;
  status?: ReactNode;
  statusTone?: ConnectionState;
  children: ReactNode;
  className?: string;
} & HTMLAttributes<HTMLElement>) {
  return <article className={`account-card ${className}`.trim()} {...articleProps}>
    <div className="account-top">
      <span><b>{name}</b>{subtitle && <small>{subtitle}</small>}</span>
      {status && <span className={`account-connection-status ${statusTone}`}><i className="dot" />{status}</span>}
    </div>
    {children}
  </article>;
}
