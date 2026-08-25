import { useState, type FormEvent } from 'react';
import { api } from '../../app/api';
import { setBasicCredentials } from '../../app/auth';
import './login.css';

type LoginPageProps = { onAuthenticated: () => void };

type AuthProbe = { auth?: { required?: boolean; mode?: string } };

export function LoginPage({ onAuthenticated }: LoginPageProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextUsername = username.trim();
    if (!nextUsername || !password) {
      setError('Enter your username and password to continue.');
      return;
    }
    setError('');
    setIsSubmitting(true);
    setBasicCredentials(nextUsername, password);
    try {
      await api<AuthProbe>('/api/health');
      onAuthenticated();
    } catch {
      setError('Those credentials were not accepted. Check them and try again.');
    } finally {
      setIsSubmitting(false);
    }
  }

  const disabled = isSubmitting || !username.trim() || !password;
  return <main className="login-page">
    <div className="login-orbit login-orbit-one" aria-hidden="true" />
    <div className="login-orbit login-orbit-two" aria-hidden="true" />
    <section className="login-card" aria-labelledby="login-title">
      <div className="login-brand"><span className="login-mark">HC</span><span>BURROW</span></div>
      <div className="login-kicker">PRIVATE OPERATOR CONSOLE</div>
      <h1 id="login-title">Welcome back.</h1>
      <p className="login-copy">Sign in to continue into your workspace.</p>
      <form onSubmit={submit} noValidate>
        <label htmlFor="login-username">Username</label>
        <input id="login-username" name="username" type="text" autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} disabled={isSubmitting} autoFocus />
        <label htmlFor="login-password">Password</label>
        <input id="login-password" name="password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} disabled={isSubmitting} />
        {error && <p className="login-error" role="alert">{error}</p>}
        <button className="login-submit" type="submit" disabled={disabled}>{isSubmitting ? 'Checking access…' : 'Enter workspace'}<span aria-hidden="true">↗</span></button>
      </form>
      <p className="login-footnote">Your credentials stay in memory for this session.</p>
    </section>
  </main>;
}
