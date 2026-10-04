import { useEffect, useState, type ReactNode } from 'react';
import { LoginPage } from './LoginPage';

/** Renders reauthentication over an already-mounted workspace so drafts and local state remain owned by their existing components. */
export function ReauthGate({ children }: { children: ReactNode }) {
 const [required, setRequired] = useState(false);
 useEffect(() => {
  const onAuthRequired = () => setRequired(true);
  window.addEventListener('burrow:auth-required', onAuthRequired);
  return () => window.removeEventListener('burrow:auth-required', onAuthRequired);
 }, []);
 return <>{children}{required && <div className="reauth-overlay"><LoginPage overlay onAuthenticated={() => setRequired(false)} /></div>}</>;
}
