import { useState } from 'react';
import { api } from '../api';
import { Logo } from '../components/Logo';

const aurora = (
  <div className="aurora" aria-hidden="true">
    <div className="blob-cyan" />
    <div className="blob-violet" />
  </div>
);

const inputCls =
  'w-full mt-1 rounded-[12px] border border-glassborder bg-inset px-3 py-2.5 text-[13px] text-ink placeholder:text-faint focus:border-accentborder outline-none';

export function SetupScreen({ onDone }: { onDone: () => void }) {
  const [token, setToken] = useState('');
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.setup(token.trim(), username.trim(), password);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-[100svh] flex items-center justify-center p-6">
      {aurora}
      <form onSubmit={submit} className="card p-6 w-full max-w-[400px]">
        <div className="flex items-center gap-2.5">
          <Logo size={26} />
          <p className="label">ZCode Bot · first-run setup</p>
        </div>
        <h1 className="text-[19px] font-bold mt-1.5">Create the dashboard user</h1>
        <p className="text-[12px] text-muted mt-2">
          The one-time setup token is printed on the server console (and in{' '}
          <code className="mono text-[11px]">data/setup-token.txt</code>). Passwords are hashed locally
          (scrypt) and never leave this machine.
        </p>
        <label className="label block mt-4">Setup token</label>
        <input
          value={token}
          onChange={(e) => setToken(e.target.value)}
          className={`${inputCls} font-mono`}
          placeholder="one-time token from console"
          required
        />
        <label className="label block mt-3">Username</label>
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          className={inputCls}
          minLength={3}
          maxLength={32}
          required
        />
        <label className="label block mt-3">Password (min 10 chars)</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className={inputCls}
          minLength={10}
          required
        />
        {error && <p className="text-[12px] text-neg mt-3">{error}</p>}
        <button
          type="submit"
          disabled={busy}
          className="mt-5 w-full rounded-[12px] bg-accentdim border border-accentborder text-accent font-semibold text-[13px] py-2.5 disabled:opacity-50 cursor-pointer hover:bg-accent/10"
        >
          {busy ? 'Creating…' : 'Create user & sign in'}
        </button>
      </form>
    </div>
  );
}

export function LoginScreen({ onDone }: { onDone: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(username.trim(), password);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-[100svh] flex items-center justify-center p-6">
      {aurora}
      <form onSubmit={submit} className="card p-6 w-full max-w-[380px]">
        <div className="flex items-center gap-2.5">
          <Logo size={26} />
          <p className="label">ZCode Bot · sign in</p>
        </div>
        <h1 className="text-[19px] font-bold mt-1.5">Dashboard login</h1>
        <label className="label block mt-4">Username</label>
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          className={inputCls}
          required
          autoFocus
        />
        <label className="label block mt-3">Password</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className={inputCls}
          required
        />
        {error && <p className="text-[12px] text-neg mt-3">{error}</p>}
        <button
          type="submit"
          disabled={busy}
          className="mt-5 w-full rounded-[12px] bg-accentdim border border-accentborder text-accent font-semibold text-[13px] py-2.5 disabled:opacity-50 cursor-pointer hover:bg-accent/10"
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
