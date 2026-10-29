import { useEffect, useState } from 'react';
import { api } from './api';
import { useDashboard } from './useDashboard';
import { LoginScreen, SetupScreen } from './pages/Auth';
import { Dashboard } from './pages/Dashboard';
import { SettingsPage } from './pages/Settings';
import { AuditPage } from './pages/Audit';
import { OperationsPage } from './pages/Operations';

type Route = 'dashboard' | 'settings' | 'audit' | 'ops';

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
    <div className="min-h-[100svh] max-w-[480px] mx-auto px-4">
      <div className="aurora" aria-hidden="true">
        <div className="blob-mint" />
        <div className="blob-violet" />
      </div>

      <nav className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 card !rounded-full px-2 py-1.5 flex gap-1">
        <NavBtn active={route === 'dashboard'} onClick={() => go('dashboard')}>
          TRADE
        </NavBtn>
        <NavBtn active={route === 'ops'} onClick={() => go('ops')}>
          OPS
        </NavBtn>
        <NavBtn active={route === 'settings'} onClick={() => go('settings')}>
          SETTINGS
        </NavBtn>
        <NavBtn active={route === 'audit'} onClick={() => go('audit')}>
          AUDIT
        </NavBtn>
        <NavBtn
          active={false}
          onClick={() => {
            void api.logout().then(() => setAuthState('loggedOut'));
          }}
        >
          EXIT
        </NavBtn>
      </nav>

      {route === 'dashboard' &&
        (state ? (
          <Dashboard
            state={state}
            connected={connected}
            onDemoReplay={() => void api.demoStart().catch(() => undefined)}
          />
        ) : (
          <p className="pt-10 text-center text-[13px] text-[#7d78a0]">connecting…</p>
        ))}
      {route === 'ops' && <OperationsPage onBack={() => go('dashboard')} />}
      {route === 'settings' && <SettingsPage onBack={() => go('dashboard')} onChanged={() => undefined} />}
      {route === 'audit' && <AuditPage onBack={() => go('dashboard')} />}
    </div>
  );
}

function NavBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: string }) {
  return (
    <button
      onClick={onClick}
      className={`label !text-[9px] rounded-full px-3 py-1.5 transition-colors ${active ? 'bg-[#2a2740] text-white' : 'hover:bg-white/70'}`}
    >
      {children}
    </button>
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
