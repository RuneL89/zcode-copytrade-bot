import { useState } from 'react';
import { api } from '../api';

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
      <div className="aurora" aria-hidden="true">
        <div className="blob-mint" />
        <div className="blob-violet" />
      </div>
      <form onSubmit={submit} className="card p-6 w-full max-w-[400px]">
        <p className="label">ZCODE BOT · FIRST-RUN SETUP</p>
        <h1 className="text-[20px] font-bold mt-1">Create the dashboard user</h1>
        <p className="text-[12px] text-[#7d78a0] mt-2">
          The one-time setup token is printed on the server console (and in{' '}
          <code className="text-[11px]">data/setup-token.txt</code>). Passwords are hashed locally (scrypt)
          and never leave this machine.
        </p>
        <label className="label block mt-4">SETUP TOKEN</label>
        <input
          value={token}
          onChange={(e) => setToken(e.target.value)}
          className="w-full mt-1 rounded-xl border border-white bg-white/70 px-3 py-2 text-[13px] font-mono"
          placeholder="one-time token from console"
          required
        />
        <label className="label block mt-3">USERNAME</label>
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          className="w-full mt-1 rounded-xl border border-white bg-white/70 px-3 py-2 text-[13px]"
          minLength={3}
          maxLength={32}
          required
        />
        <label className="label block mt-3">PASSWORD (MIN 10 CHARS)</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full mt-1 rounded-xl border border-white bg-white/70 px-3 py-2 text-[13px]"
          minLength={10}
          required
        />
        {error && <p className="text-[12px] text-rose-600 mt-3">{error}</p>}
        <button
          type="submit"
          disabled={busy}
          className="mt-5 w-full rounded-xl bg-[#2a2740] text-white font-semibold text-[13px] py-2.5 disabled:opacity-50"
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
      <div className="aurora" aria-hidden="true">
        <div className="blob-mint" />
        <div className="blob-violet" />
      </div>
      <form onSubmit={submit} className="card p-6 w-full max-w-[380px]">
        <p className="label">ZCODE BOT · SIGN IN</p>
        <h1 className="text-[20px] font-bold mt-1">Dashboard login</h1>
        <label className="label block mt-4">USERNAME</label>
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          className="w-full mt-1 rounded-xl border border-white bg-white/70 px-3 py-2 text-[13px]"
          required
          autoFocus
        />
        <label className="label block mt-3">PASSWORD</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full mt-1 rounded-xl border border-white bg-white/70 px-3 py-2 text-[13px]"
          required
        />
        {error && <p className="text-[12px] text-rose-600 mt-3">{error}</p>}
        <button
          type="submit"
          disabled={busy}
          className="mt-5 w-full rounded-xl bg-[#2a2740] text-white font-semibold text-[13px] py-2.5 disabled:opacity-50"
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
