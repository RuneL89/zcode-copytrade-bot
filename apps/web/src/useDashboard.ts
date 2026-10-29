import { useEffect, useRef, useState } from 'react';
import type { DashboardState } from './types';

/**
 * SSE subscription with automatic reconnect. On every (re)connect the server
 * first sends the authoritative state — the UI resynchronizes instead of
 * replaying fabricated events.
 */
export function useDashboard(): { state: DashboardState | null; connected: boolean } {
  const [state, setState] = useState<DashboardState | null>(null);
  const [connected, setConnected] = useState(false);
  const retryRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let es: EventSource | null = null;
    let closed = false;

    const connect = () => {
      es = new EventSource('/api/stream');
      es.addEventListener('open', () => {
        setConnected(true);
        retryRef.current = 0;
      });
      es.addEventListener('state', (e) => {
        try {
          setState(JSON.parse((e as MessageEvent).data) as DashboardState);
        } catch {
          /* malformed frame ignored; next resync fixes it */
        }
      });
      es.addEventListener('error', () => {
        setConnected(false);
        es?.close();
        if (closed) return;
        const delay = Math.min(15000, 1000 * 2 ** Math.min(retryRef.current++, 4));
        timerRef.current = setTimeout(connect, delay);
      });
    };

    // Initial authoritative fetch (also handles no-EventSource environments).
    void fetch('/api/state', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => {
        if (s) setState(s as DashboardState);
      })
      .finally(connect);

    return () => {
      closed = true;
      es?.close();
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return { state, connected };
}
