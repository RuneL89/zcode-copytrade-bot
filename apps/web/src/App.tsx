import { useEffect, useState } from 'react';
import { api } from './api';
import { useDashboard } from './useDashboard';
import { LoginScreen, SetupScreen } from './pages/Auth';
import { AuditPage } from './pages/Audit';
import { OperationsPage } from './pages/Operations';
import { SettingsPage } from './pages/Settings';
import { WeeklyReviewPage } from './pages/WeeklyReview';
import { Redesign } from './redesign/Redesign';
import type { RedesignRoute } from './redesign/Header';

type Route = RedesignRoute | 'ops' | 'audit' | 'legacy-settings' | 'weekly';

export function App() {
  const [authState, setAuthState] = useState<'checking' | 'needsSetup' | 'loggedOut' | 'loggedIn'>(
    'checking',
  );
  const [route, setRoute] = useState<Route>(parseRoute());
  const { state, connected } = useDashboard();

  useEffect(() => {
    // A valid session cookie must survive a reload: probe the state endpoint
    // first and only fall back to the setup/login decision when it is refused.
    void api.state().then(
      () => setAuthState('loggedIn'),
      () => {
        void api
          .bootstrap()
          .then((b) => setAuthState(b.needsSetup ? 'needsSetup' : 'loggedOut'))
          .catch(() => setAuthState('loggedOut'));
      },
    );
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

  // The ops console and audit log stay reachable from the redesign's footer,
  // but they keep their legacy layout (they are operator tools, not the desk).
  if (route === 'ops') {
    return (
      <div className="relative min-h-[100svh] w-full max-w-[1080px] mx-auto px-4">
        <div className="aurora" aria-hidden="true">
          <div className="blob-cyan" />
          <div className="blob-violet" />
        </div>
        {state ? <OperationsPage state={state} onBack={() => go('line')} /> : <ConnectingSkeleton />}
      </div>
    );
  }
  if (route === 'audit') {
    return (
      <div className="relative min-h-[100svh] w-full max-w-[1080px] mx-auto px-4">
        <div className="aurora" aria-hidden="true">
          <div className="blob-cyan" />
          <div className="blob-violet" />
        </div>
        <AuditPage onBack={() => go('line')} />
      </div>
    );
  }
  if (route === 'legacy-settings') {
    // Provider keys and the manual leaderboard import stay reachable, but the
    // legacy Risk and Live tabs are hidden: the redesign has one risk editor
    // and no arm-live control.
    return (
      <div className="relative min-h-[100svh] w-full max-w-[1080px] mx-auto px-4">
        <div className="aurora" aria-hidden="true">
          <div className="blob-cyan" />
          <div className="blob-violet" />
        </div>
        <SettingsPage onBack={() => go('line')} initialTab="keys" showRisk={false} showLive={false} />
      </div>
    );
  }
  if (route === 'weekly') {
    // Read-only operator report. It keeps the legacy page shell like Audit and
    // Ops, is reached from the audit log, and returns there.
    return (
      <div className="relative min-h-[100svh] w-full max-w-[1080px] mx-auto px-4">
        <div className="aurora" aria-hidden="true">
          <div className="blob-cyan" />
          <div className="blob-violet" />
        </div>
        <WeeklyReviewPage onBack={() => go('audit')} />
      </div>
    );
  }

  if (!state) {
    return (
      <div className="cdx">
        <ConnectingSkeleton />
      </div>
    );
  }

  return (
    <Redesign
      state={state}
      connected={connected}
      route={route}
      onRoute={go}
      onDemoReplay={() => void api.demoStart().catch(() => undefined)}
    />
  );
}

/** Skeleton placeholders while the first SSE state is in flight. */
function ConnectingSkeleton() {
  return (
    <div aria-live="polite" aria-label="connecting" className="pt-6 px-4">
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
  const raw = window.location.hash.replace(/^#\/?/, '').replace(/\/$/, '');
  if (raw === 'seats' || raw === 'desk') return 'seats';
  if (raw === 'credits') return 'credits';
  if (raw === 'risk' || raw === 'settings') return 'risk';
  if (raw === 'ops') return 'ops';
  if (raw === 'audit') return 'audit';
  if (raw === 'weekly') return 'weekly';
  if (raw === 'legacy-settings' || raw === 'keys') return 'legacy-settings';
  // Legacy #/dashboard and the empty hash both land on the funnel.
  return 'line';
}

function go(route: Route) {
  window.location.hash = `#/${route === 'line' ? '' : route}`;
  window.dispatchEvent(new Event('popstate'));
}
