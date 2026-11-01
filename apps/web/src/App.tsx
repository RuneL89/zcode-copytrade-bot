import { useEffect, useState } from 'react';
import { api } from './api';
import { useDashboard } from './useDashboard';
import { LoginScreen, SetupScreen } from './pages/Auth';
import { Dashboard } from './pages/Dashboard';
import { SettingsPage } from './pages/Settings';
import { AuditPage } from './pages/Audit';
import { OperationsPage } from './pages/Operations';
import { ListIcon, PulseIcon, SlidersIcon, TerminalIcon } from './components/icons';

type Route = 'dashboard' | 'settings' | 'audit' | 'ops';

const NAV: Array<{ id: Route; label: string; icon: (props: { size?: number }) => React.JSX.Element }> = [
  { id: 'dashboard', label: 'Trade', icon: PulseIcon },
  { id: 'ops', label: 'Ops', icon: TerminalIcon },
  { id: 'settings', label: 'Settings', icon: SlidersIcon },
  { id: 'audit', label: 'Audit', icon: ListIcon },
];

export function App() {
  const [authState, setAuthState] = useState<'checking' | 'needsSetup' | 'loggedOut' | 'loggedIn'>(
    'checking',
  );
  const [route, setRoute] = useState<Route>(parseRoute());
  const { state, connected } = useDashboard();

  useEffect(() => {
    void api
      .bootstrap()
      .then((b) => setAuthState(b.needsSetup ? 'needsSetup' : 'loggedOut'))
      .catch(() => setAuthState('loggedOut'));
    const onUnauthorized = () => {
      setAuthState('loggedOut');
      void api.bootstrap().then((b) => setAuthState(b.needsSetup ? 'needsSetup' : 'loggedOut'));
    };
    window.addEventListener('zcode:unauthorized', onUnauthorized);
    const onPop = () => setRoute(parseRoute());
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('zcode:unauthorized', onUnauthorized);
      window.removeEventListener('popstate', onPop);
    };
  }, []);

  useEffect(() => {
    if (authState !== 'loggedIn') return;
    // A successful state fetch confirms the session.
    void api.state().then(
      () => setAuthState('loggedIn'),
      () => setAuthState('loggedOut'),
    );
  }, [authState]);

  if (authState === 'checking') {
    return <div className="min-h-[100svh]" />;
  }
  if (authState === 'needsSetup') {
    return <SetupScreen onDone={() => setAuthState('loggedIn')} />;
  }
  if (authState === 'loggedOut') {
    return <LoginScreen onDone={() => setAuthState('loggedIn')} />;
  }

  return (
    <div className="relative min-h-[100svh] max-w-[480px] lg:max-w-[600px] mx-auto px-4">
      <div className="aurora" aria-hidden="true">
        <div className="blob-cyan" />
        <div className="blob-violet" />
      </div>

      {route === 'dashboard' &&
        (state ? (
          <Dashboard
            state={state}
            connected={connected}
            onDemoReplay={() => void api.demoStart().catch(() => undefined)}
          />
        ) : (
          <ConnectingSkeleton />
        ))}
      {route === 'ops' && <OperationsPage onBack={() => go('dashboard')} />}
      {route === 'settings' && <SettingsPage onBack={() => go('dashboard')} />}
      {route === 'audit' && <AuditPage onBack={() => go('dashboard')} />}

      <nav className="fixed bottom-3 left-1/2 -translate-x-1/2 z-40 card !bg-glassstrong !rounded-full px-1.5 py-1.5 flex gap-0.5 pb-[calc(6px+env(safe-area-inset-bottom))]">
        {NAV.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => go(id)}
            aria-current={route === id ? 'page' : undefined}
            className={`flex flex-col items-center justify-center gap-0.5 min-w-[64px] min-h-[44px] rounded-full transition-colors cursor-pointer ${
              route === id ? 'bg-accentdim text-accent' : 'text-muted hover:text-ink'
            }`}
          >
            <Icon size={17} />
            <span className="text-[9.5px] font-semibold tracking-wide">{label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}

/** Skeleton placeholders while the first SSE state is in flight. */
function ConnectingSkeleton() {
  return (
    <div aria-live="polite" aria-label="connecting" className="pt-6">
      {[64, 120, 88, 100].map((h, i) => (
        <div key={i} className="card p-4 mb-3.5">
          <div className="skeleton rounded-lg bg-inset" style={{ height: h / 3 }} />
          <div className="skeleton rounded-lg bg-inset mt-3" style={{ height: h }} />
        </div>
      ))}
    </div>
  );
}

function parseRoute(): Route {
  const h = window.location.hash.replace('#/', '');
  return h === 'settings' || h === 'audit' || h === 'ops' ? h : 'dashboard';
}

function go(route: Route) {
  window.location.hash = `#/${route === 'dashboard' ? '' : route}`;
  window.dispatchEvent(new Event('popstate'));
}
