import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import type { AuditEvent, SettingsView } from './model';
import { numberRisk } from './model';
import { eetClock, humanReason, pct } from './format';

type FieldKind = 'int' | 'decimal' | 'bps' | 'ms' | 'bool';
interface FieldDef {
  key: string;
  label: string;
  desc: string;
  group: string;
  unit: string;
  kind: FieldKind;
  min?: number;
  max?: number;
  step?: number;
}

const FIELDS: FieldDef[] = [
  {
    key: 'COPY_SCALE',
    label: 'Copy scale',
    desc: 'Your size = leader size × scale',
    group: 'sizing',
    unit: '×',
    kind: 'decimal',
    min: 0.05,
    max: 1,
    step: 0.05,
  },
  {
    key: 'MIN_PER_BUY_USD',
    label: 'Floor per trade',
    desc: 'Hard floor: every copied buy is at least this. Leader buys that scale below it are lifted to the floor — never skipped.',
    group: 'sizing',
    unit: '$',
    kind: 'int',
    min: 1,
    max: 50,
    step: 1,
  },
  {
    key: 'MAX_PER_BUY_USD',
    label: 'Cap per trade',
    desc: 'Max USD for a single copy',
    group: 'sizing',
    unit: '$',
    kind: 'int',
    min: 2,
    max: 500,
    step: 1,
  },
  {
    key: 'MAX_OPEN_PER_TRADER_USD',
    label: 'Max open per trader',
    desc: 'Entries plus fees for one hired leader',
    group: 'sizing',
    unit: '$',
    kind: 'int',
    min: 2,
    max: 500,
    step: 1,
  },
  {
    key: 'MAX_DEPLOYED_PCT',
    label: 'Max deployed',
    desc: 'Share of capital in open positions',
    group: 'sizing',
    unit: '%',
    kind: 'int',
    min: 1,
    max: 100,
    step: 1,
  },
  {
    key: 'MAX_SLIPPAGE_BPS',
    label: 'Entry slippage',
    desc: 'Jupiter quote slippage limit',
    group: 'exec',
    unit: 'bps',
    kind: 'int',
    min: 10,
    max: 1000,
    step: 10,
  },
  {
    key: 'MAX_PRICE_IMPACT_BPS',
    label: 'Max price impact',
    desc: 'Skip the copy above this quote impact',
    group: 'exec',
    unit: 'bps',
    kind: 'int',
    min: 10,
    max: 1000,
    step: 10,
  },
  {
    key: 'MAX_COPY_EVENT_AGE_SECONDS',
    label: 'Max event age',
    desc: 'Leader buys older than this are never copied',
    group: 'exec',
    unit: 's',
    kind: 'int',
    min: 15,
    max: 180,
    step: 5,
  },
  {
    key: 'PRICE_MAX_AGE_SECONDS',
    label: 'Max price age',
    desc: 'A stale price never sizes an order',
    group: 'exec',
    unit: 's',
    kind: 'int',
    min: 5,
    max: 300,
    step: 5,
  },
  {
    key: 'EXIT_SLIPPAGE_BPS_1',
    label: 'Exit slippage step 1',
    desc: 'First attempt on a stuck exit',
    group: 'exec',
    unit: 'bps',
    kind: 'int',
    min: 50,
    max: 2000,
    step: 50,
  },
  {
    key: 'EXIT_SLIPPAGE_BPS_2',
    label: 'Exit slippage step 2',
    desc: 'Second attempt',
    group: 'exec',
    unit: 'bps',
    kind: 'int',
    min: 50,
    max: 2000,
    step: 50,
  },
  {
    key: 'EXIT_SLIPPAGE_BPS_3',
    label: 'Exit slippage step 3',
    desc: 'Last step; later attempts reuse it',
    group: 'exec',
    unit: 'bps',
    kind: 'int',
    min: 50,
    max: 2000,
    step: 50,
  },

  {
    key: 'STOP_LOSS_BPS',
    label: 'Hard stop-loss',
    desc: 'Sell the whole position at this loss from our entry',
    group: 'exits',
    unit: '%',
    kind: 'bps',
    min: 5,
    max: 60,
    step: 1,
  },
  {
    key: 'TRAIL_ARM_BPS',
    label: 'Trailing stop arms at',
    desc: 'Gain from entry that switches the trailing stop on',
    group: 'exits',
    unit: '%',
    kind: 'bps',
    min: 5,
    max: 60,
    step: 1,
  },
  {
    key: 'TRAIL_DISTANCE_BPS',
    label: 'Trailing distance',
    desc: 'Sell if price falls this far from its peak after arming',
    group: 'exits',
    unit: '%',
    kind: 'bps',
    min: 3,
    max: 30,
    step: 1,
  },
  {
    key: 'PARTIAL_TP_BPS',
    label: 'Partial take-profit at',
    desc: 'Sell half the position at this gain',
    group: 'exits',
    unit: '%',
    kind: 'bps',
    min: 5,
    max: 200,
    step: 5,
  },
  {
    key: 'MAX_POSITION_AGE_HOURS',
    label: 'Max hold',
    desc: 'Every position is a day trade: time exit after this',
    group: 'exits',
    unit: 'h',
    kind: 'int',
    min: 1,
    max: 12,
    step: 1,
  },
  {
    key: 'POSITION_GRACE_HOURS',
    label: 'Grace if red at max hold',
    desc: 'Sell as soon as it turns green; force-close at the end',
    group: 'exits',
    unit: 'h',
    kind: 'decimal',
    min: 0,
    max: 4,
    step: 0.5,
  },
  {
    key: 'GRACE_BOUNCE_BPS',
    label: 'Grace bounce exit',
    desc: 'In grace, sell once price is this far above its low',
    group: 'exits',
    unit: '%',
    kind: 'bps',
    min: 2,
    max: 30,
    step: 1,
  },
  {
    key: 'SELL_ON_GREEN',
    label: 'Sell on green',
    desc: 'Sell as soon as a position is green at max hold or during grace',
    group: 'exits',
    unit: '',
    kind: 'bool',
  },

  {
    key: 'COOLDOWN_HOURS',
    label: 'Rehire cooldown',
    desc: 'A fired trader may return after this long only if a chair is still free; hiring another trader lifts the block immediately',
    group: 'cool',
    unit: 'h',
    kind: 'int',
    min: 1,
    max: 168,
    step: 1,
  },
  {
    key: 'MAX_HIRES_PER_DAY',
    label: 'Max hires / day',
    desc: 'Further openings wait for you',
    group: 'cool',
    unit: '',
    kind: 'int',
    min: 1,
    max: 10,
    step: 1,
  },
  {
    key: 'IDLE_FIRE_HOURS',
    label: 'Idle fire',
    desc: 'Fire a hire after this long with zero open positions',
    group: 'cool',
    unit: 'h',
    kind: 'int',
    min: 1,
    max: 24,
    step: 1,
  },

  {
    key: 'ROSTER_SIZE',
    label: 'Roster size',
    desc: 'Hired seats sharing one budget pool',
    group: 'roster',
    unit: '',
    kind: 'int',
    min: 1,
    max: 10,
    step: 1,
  },
  {
    key: 'WATCH_LIST_SIZE',
    label: 'Watch list cap',
    desc: 'Hard cap; inserts beyond this are refused',
    group: 'roster',
    unit: '',
    kind: 'int',
    min: 5,
    max: 40,
    step: 1,
  },
  {
    key: 'BENCH_TARGET',
    label: 'Bench target',
    desc: 'Promotable wallets the discovery trigger keeps',
    group: 'roster',
    unit: '',
    kind: 'int',
    min: 1,
    max: 40,
    step: 1,
  },
  {
    key: 'ADMISSION_MIN_BUYS_24H',
    label: 'Admission buys / 24h',
    desc: 'Funded buys required to join the watch list',
    group: 'roster',
    unit: '',
    kind: 'int',
    min: 1,
    max: 20,
    step: 1,
  },
  {
    key: 'ADMISSION_MAX_LAST_BUY_HOURS',
    label: 'Admission recency',
    desc: 'The last funded buy must be within this',
    group: 'roster',
    unit: 'h',
    kind: 'int',
    min: 1,
    max: 168,
    step: 1,
  },
  {
    key: 'PROMOTION_MIN_CLOSED',
    label: 'Promotion sample',
    desc: 'Closed shadow trades required',
    group: 'roster',
    unit: '',
    kind: 'int',
    min: 1,
    max: 50,
    step: 1,
  },
  {
    key: 'PROMOTION_MIN_NET_USD',
    label: 'Promotion net',
    desc: 'Net shadow PnL the sample must beat',
    group: 'roster',
    unit: '$',
    kind: 'int',
    min: 1,
    max: 500,
    step: 1,
  },
  {
    key: 'PROMOTION_MAX_LAST_BUY_HOURS',
    label: 'Promotion recency',
    desc: 'Last funded buy must be this fresh',
    group: 'roster',
    unit: 'h',
    kind: 'int',
    min: 1,
    max: 24,
    step: 1,
  },
  {
    key: 'PER_MINT_CAP_USD',
    label: 'Per-mint cap',
    desc: '0 disables the cap',
    group: 'roster',
    unit: '$',
    kind: 'int',
    min: 0,
    max: 500,
    step: 1,
  },
  {
    key: 'WATCH_EVICTION_DAYS',
    label: 'Watch eviction',
    desc: 'Evict wallets that fail the screen for this long',
    group: 'roster',
    unit: 'd',
    kind: 'int',
    min: 1,
    max: 90,
    step: 1,
  },
  {
    key: 'SHADOW_BACKFILL_ON_ADMIT',
    label: 'Backfill on admit',
    desc: 'Seed the shadow record from the admission scan',
    group: 'roster',
    unit: '',
    kind: 'bool',
  },

  {
    key: 'WATCH_POLL_MS',
    label: 'Watch poll',
    desc: 'Signature poll per watched wallet',
    group: 'polls',
    unit: 'min',
    kind: 'ms',
    min: 1,
    max: 60,
    step: 1,
  },
  {
    key: 'ROSTER_POLL_MS',
    label: 'Roster poll',
    desc: 'Signature poll per hired wallet',
    group: 'polls',
    unit: 'min',
    kind: 'ms',
    min: 0.25,
    max: 5,
    step: 0.25,
  },
  {
    key: 'DISCOVERY_MIN_INTERVAL_MS',
    label: 'Discovery interval',
    desc: 'At most one discovery run per interval',
    group: 'polls',
    unit: 'min',
    kind: 'ms',
    min: 10,
    max: 240,
    step: 5,
  },
];

const GROUPS: Array<{ id: string; title: string; note?: string }> = [
  { id: 'sizing', title: 'Sizing & loss limits' },
  { id: 'exec', title: 'Execution' },
  { id: 'exits', title: 'Exits · day-trader rules' },
  { id: 'cool', title: 'Cooldown & firing' },
  { id: 'roster', title: 'Roster & watch' },
  { id: 'polls', title: 'Polling cadence' },
];

const HIGHER_IS_RISKIER = new Set([
  'MAX_PER_BUY_USD',
  'MAX_OPEN_PER_TRADER_USD',
  'MAX_DEPLOYED_PCT',
  'STOP_LOSS_BPS',
  'TRAIL_DISTANCE_BPS',
  'TRAIL_ARM_BPS',
  'MAX_POSITION_AGE_HOURS',
  'POSITION_GRACE_HOURS',
  'EXIT_SLIPPAGE_BPS_1',
  'EXIT_SLIPPAGE_BPS_2',
  'EXIT_SLIPPAGE_BPS_3',
  'MAX_HIRES_PER_DAY',
]);
const LOWER_IS_RISKIER = new Set(['MIN_PER_BUY_USD']);

function displayValue(field: FieldDef, raw: number): number {
  if (field.kind === 'bps') return raw / 100;
  if (field.kind === 'ms') return Math.round((raw / 60_000) * 100) / 100;
  return raw;
}

function rawValue(field: FieldDef, input: number): number {
  if (field.kind === 'bps') return Math.round(input * 100);
  if (field.kind === 'ms') return Math.round(input * 60_000);
  if (field.kind === 'int') return Math.round(input);
  return input;
}

function formatDisplay(field: FieldDef, raw: number): string {
  const value = displayValue(field, raw);
  if (field.kind === 'bps') return `${value}%`;
  if (field.kind === 'ms') return `${value} min`;
  if (field.unit === '$') return `$${value}`;
  if (field.unit === '×') return `${value}×`;
  return `${value}${field.unit ? ` ${field.unit}` : ''}`;
}

function draftPatch(settings: SettingsView, draft: Record<string, string>): Record<string, number | boolean> {
  const patch: Record<string, number | boolean> = {};
  for (const field of FIELDS) {
    const current = settings.risk[field.key];
    if (field.kind === 'bool') {
      const next = draft[field.key] === 'true';
      if (next !== Boolean(current)) patch[field.key] = next;
      continue;
    }
    const num = Number(draft[field.key]);
    if (!Number.isFinite(num)) continue;
    const next = rawValue(field, num);
    if (typeof current !== 'number' || next !== current) patch[field.key] = next;
  }
  return patch;
}

function riskDirection(
  settings: SettingsView,
  patch: Record<string, number | boolean>,
): 'increase' | 'decrease' | 'neutral' {
  const current = settings.risk;
  let direction: 'increase' | 'decrease' | 'neutral' = 'neutral';
  for (const key of Object.keys(patch)) {
    const next = patch[key];
    const prev = current[key];
    if (typeof next !== 'number' || typeof prev !== 'number' || next === prev) continue;
    if (HIGHER_IS_RISKIER.has(key) && next > prev) return 'increase';
    if (HIGHER_IS_RISKIER.has(key) && next < prev) direction = 'decrease';
    if (LOWER_IS_RISKIER.has(key) && next < prev) return 'increase';
    if (LOWER_IS_RISKIER.has(key) && next > prev) direction = 'decrease';
  }
  if (patch.SELL_ON_GREEN === false && current.SELL_ON_GREEN !== false) return 'increase';
  if (patch.SELL_ON_GREEN === true && current.SELL_ON_GREEN === false) direction = 'decrease';
  return direction;
}

export function RiskPage({
  settings,
  audit,
  onSaved,
  onPausedChanged,
}: {
  settings: SettingsView;
  audit: AuditEvent[];
  onSaved: () => void;
  onPausedChanged: () => void;
}) {
  const [draft, setDraft] = useState<Record<string, string>>(() => initialDraft(settings));
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<null | {
    patch: Record<string, number | boolean>;
    increases: boolean;
  }>(null);
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const foldRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setDraft(initialDraft(settings));
  }, [settings]);

  const patch = useMemo(() => draftPatch(settings, draft), [draft, settings]);
  const changes = Object.keys(patch).length;
  const direction = useMemo(() => riskDirection(settings, patch), [patch, settings]);
  const maxHires = numberRisk(settings.risk, 'MAX_HIRES_PER_DAY', 3);
  const hireMode = settings.hiring?.mode ?? 'auto';

  const setField = (key: string, value: string) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setStatus(null);
  };

  const review = () => {
    if (changes === 0) {
      setStatus('No changes to save.');
      return;
    }
    setError(null);
    for (const field of FIELDS) {
      if (field.kind === 'bool') continue;
      const num = Number(draft[field.key]);
      if (!Number.isFinite(num) || num < (field.min ?? -Infinity) || num > (field.max ?? Infinity)) {
        setError(
          `${field.label}: enter a value between ${field.min ?? '—'} and ${field.max ?? '—'} ${field.unit}`,
        );
        return;
      }
    }
    setPin('');
    setConfirm({ patch, increases: direction === 'increase' });
  };

  const save = async () => {
    if (!confirm) return;
    if (confirm.increases && pin.trim().length === 0) {
      setError('This change raises risk. Enter the dashboard PIN.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.patchSettings({ ...confirm.patch, ...(confirm.increases ? { pin: pin.trim() } : {}) });
      setStatus(`Saved ${changes} change${changes === 1 ? '' : 's'} and applied them.`);
      setConfirm(null);
      setPin('');
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const togglePause = async () => {
    setBusy(true);
    try {
      if (settings.control.newEntriesPaused) await api.resume();
      else await api.pause('paused from the risk screen');
      onPausedChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const startHold = () => {
    if (settings.control.emergencyStopped) return;
    holdTimer.current = setTimeout(() => {
      void api
        .emergencyStop()
        .then(() => {
          setStatus('Emergency stop engaged. Exits are queued; entries are halted.');
          onPausedChanged();
        })
        .catch((e: Error) => setError(e.message));
    }, 1500);
  };
  const cancelHold = () => {
    if (holdTimer.current) clearTimeout(holdTimer.current);
    holdTimer.current = null;
  };

  const clearEmergency = async () => {
    try {
      await api.emergencyClear();
      setStatus('Emergency stop cleared.');
      onPausedChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <section className="view on" id="v-risk" data-testid="desk-risk">
      <div className="toolbar">
        <div>
          <h2 className="title">Risk settings</h2>
          <div className="sub">
            One risk editor. Changes that increase risk need the PIN; every change goes through the server's
            validated PATCH and is written to the audit log.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span className="dim" style={{ fontSize: 12 }}>
            Mode
          </span>
          <span className={`badge ${settings.mode === 'live' ? 'live' : 'paper'}`}>
            {settings.mode.toUpperCase()}
          </span>
        </div>
      </div>

      {(status || error) && (
        <div
          className={`risk-notice ${error ? 'bad' : 'good'}`}
          role={error ? 'alert' : 'status'}
          data-testid="save-risk-status"
        >
          {error ?? status}
        </div>
      )}

      <div className="g grisk" style={{ gridTemplateColumns: '1.5fr 1fr' }}>
        <div style={{ minWidth: 0 }} ref={foldRef}>
          {GROUPS.map((group) => (
            <div className="panel" style={{ marginTop: group.id === 'sizing' ? 0 : 14 }} key={group.id}>
              <div className="ph">
                <h3>{group.title}</h3>
                {group.id === 'exits' && <span className="pill info r">code · every poll</span>}
              </div>
              {FIELDS.filter((field) => field.group === group.id).map((field) => (
                <FieldRow
                  key={field.key}
                  field={field}
                  value={draft[field.key] ?? ''}
                  changed={field.key in patch}
                  risky={direction === 'increase' && field.key in patch}
                  onChange={(value) => setField(field.key, value)}
                />
              ))}
            </div>
          ))}

          <div className="panel" style={{ marginTop: 14 }}>
            <div className="ph">
              <h3>Hiring</h3>
              <span className="dim" style={{ fontSize: 12 }}>
                HIRE_APPROVAL from .env · read-only in the UI
              </span>
            </div>
            <div className="set">
              <div>
                <div className="lb">Who fills a free seat</div>
                <div className="ds">
                  {hireMode === 'agent'
                    ? 'Copytrader decides via the agent webhook; you can overrule any hire.'
                    : 'The code fills the chair from the promotion queue. Manual approval is not a runtime mode.'}
                </div>
              </div>
              <div className="ctl">
                <span className="seg hireseg">
                  <button className={hireMode === 'agent' ? 'on' : ''} disabled>
                    Copytrader
                  </button>
                  <button className={hireMode === 'auto' ? 'on' : ''} disabled>
                    Auto
                  </button>
                </span>
              </div>
            </div>
            <div className="set">
              <div>
                <div className="lb">Activations started today</div>
                <div className="ds">Every chair start, including code fills from the promotion queue.</div>
              </div>
              <div className="ctl num">{settings.hiring?.hiresToday ?? 0}</div>
            </div>
            <div className="set">
              <div>
                <div className="lb">Agent hire cap</div>
                <div className="ds">MAX_HIRES_PER_DAY applies to agent decisions only.</div>
              </div>
              <div className="ctl num">{maxHires} / day</div>
            </div>
          </div>
        </div>

        <div className="rcol" style={{ display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
          <div className="panel ctrlcard">
            <div className="ph" style={{ marginBottom: 2 }}>
              <h3>Controls</h3>
            </div>
            <div className="cbig">
              <div>
                <b>
                  {settings.control.emergencyStopped
                    ? 'Emergency stopped'
                    : settings.control.newEntriesPaused
                      ? 'Entries paused'
                      : 'Entries running'}
                </b>
                <span>
                  {settings.control.emergencyStopped
                    ? 'No entries. Existing positions are being closed.'
                    : settings.control.newEntriesPaused
                      ? 'Exits still run; no new copies'
                      : 'New copies are allowed'}
                </span>
              </div>
              <button
                className="btn"
                onClick={() => void togglePause()}
                disabled={busy || settings.control.emergencyStopped}
              >
                {settings.control.newEntriesPaused ? 'Resume entries' : 'Pause entries'}
              </button>
            </div>
            <div className="cbig">
              <div>
                <b>Emergency stop</b>
                <span>Halts entries and queues exits for all positions</span>
              </div>
              {settings.control.emergencyStopped ? (
                <button className="btn" onClick={() => void clearEmergency()}>
                  Clear stop
                </button>
              ) : (
                <button
                  className="btn danger hold"
                  onPointerDown={startHold}
                  onPointerUp={cancelHold}
                  onPointerLeave={cancelHold}
                  onPointerCancel={cancelHold}
                  title="Hold for 1.5 seconds"
                >
                  <span className="lbl">Hold to stop</span>
                </button>
              )}
            </div>
            <div className="cbig">
              <div>
                <b>Live trading</b>
                <span>
                  Not available from this screen. The badge reflects MODE; arming stays outside the redesign.
                </span>
              </div>
              <span className={`badge ${settings.mode === 'live' ? 'live' : 'paper'}`}>
                {settings.mode.toUpperCase()}
              </span>
            </div>
          </div>

          <div className="panel logp">
            <div className="ph">
              <h3>Change log</h3>
              <span className="r dim" style={{ fontSize: 12 }}>
                audit stream
              </span>
            </div>
            <div className="log">
              {audit
                .filter((event) =>
                  ['settings', 'control', 'agent', 'firing', 'roster'].includes(event.category),
                )
                .slice(0, 10)
                .map((event) => (
                  <div className="it" key={event.id}>
                    <span className="ts num">{eetClock(event.createdAt)}</span>
                    <span
                      className={`who ${event.category === 'settings' ? 'you' : event.category === 'agent' ? 'agent' : 'sys'}`}
                    >
                      {event.category === 'settings' ? 'you' : event.category === 'agent' ? 'agent' : 'sys'}
                    </span>
                    <span>{event.message}</span>
                  </div>
                ))}
              {audit.filter((event) =>
                ['settings', 'control', 'agent', 'firing', 'roster'].includes(event.category),
              ).length === 0 && (
                <div className="dim" style={{ fontSize: 12 }}>
                  No changes recorded yet.
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {changes > 0 && (
        <div className="savebar on">
          <span style={{ fontSize: 13 }}>
            {changes} change{changes > 1 ? 's' : ''}
            {direction === 'increase' && <span style={{ color: '#fca5a5' }}> · raises risk, PIN needed</span>}
          </span>
          <span style={{ marginLeft: 'auto' }} />
          <button className="btn ghost" onClick={() => setDraft(initialDraft(settings))}>
            Discard
          </button>
          <button className="btn pri" onClick={review} data-testid="save-risk">
            Review &amp; save
          </button>
        </div>
      )}

      {confirm && (
        <div className="modal on" role="dialog" aria-modal="true" data-testid="risk-confirm">
          <div className="mbox">
            <h3>{confirm.increases ? 'Confirm risk increase' : 'Save changes'}</h3>
            <div className="sub">
              {confirm.increases
                ? 'At least one change raises risk. Enter the dashboard PIN to apply it.'
                : 'These changes lower or keep risk the same.'}
            </div>
            <div className="diff">
              {Object.entries(confirm.patch).map(([key, value]) => {
                const field = FIELDS.find((item) => item.key === key);
                if (!field) return null;
                const current = settings.risk[key];
                const increases =
                  (HIGHER_IS_RISKIER.has(key) &&
                    typeof value === 'number' &&
                    typeof current === 'number' &&
                    value > current) ||
                  (LOWER_IS_RISKIER.has(key) &&
                    typeof value === 'number' &&
                    typeof current === 'number' &&
                    value < current) ||
                  (key === 'SELL_ON_GREEN' && value === false && current !== false);
                return (
                  <div key={key}>
                    <span>{field.label}</span>
                    <span className="num">
                      <span className="dim">
                        {typeof current === 'number' ? formatDisplay(field, current) : String(current)}
                      </span>
                      {' → '}
                      <b style={{ color: increases ? '#fca5a5' : '#86efac' }}>
                        {typeof value === 'number' ? formatDisplay(field, value) : value ? 'On' : 'Off'}
                      </b>{' '}
                      {increases ? '↑' : '↓'}
                    </span>
                  </div>
                );
              })}
            </div>
            {confirm.increases && (
              <>
                <input
                  className="inp"
                  type="password"
                  inputMode="numeric"
                  autoComplete="off"
                  placeholder="Dashboard PIN"
                  aria-label="Risk PIN"
                  data-testid="risk-pin"
                  value={pin}
                  onChange={(event) => setPin(event.target.value)}
                  autoFocus
                  style={{ width: '100%', textAlign: 'center', padding: 10 }}
                />
                <div className="dim" style={{ textAlign: 'center', fontSize: 11.5, marginTop: 6 }}>
                  The server checks the PIN. Without it the risk increase is refused.
                </div>
              </>
            )}
            {error && (
              <div
                className="risk-notice bad"
                style={{ marginTop: 10 }}
                role="alert"
                data-testid="risk-confirm-error"
              >
                {error}
              </div>
            )}
            <div className="mact">
              <button className="btn ghost" onClick={() => setConfirm(null)} disabled={busy}>
                Cancel
              </button>
              <button
                className="btn pri"
                onClick={() => void save()}
                disabled={busy || (confirm.increases && pin.trim().length === 0)}
                data-testid="risk-confirm-save"
              >
                {busy ? 'Saving…' : confirm.increases ? 'Confirm with PIN' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function initialDraft(settings: SettingsView): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of FIELDS) {
    const raw = settings.risk[field.key];
    if (field.kind === 'bool') out[field.key] = String(Boolean(raw));
    else if (typeof raw === 'number') out[field.key] = String(displayValue(field, raw));
    else out[field.key] = '';
  }
  return out;
}

function FieldRow({
  field,
  value,
  changed,
  risky,
  onChange,
}: {
  field: FieldDef;
  value: string;
  changed: boolean;
  risky: boolean;
  onChange: (value: string) => void;
}) {
  if (field.kind === 'bool') {
    return (
      <div
        className={`set ${changed ? 'changed' : ''} ${risky ? 'up' : ''}`}
        data-testid={`risk-row-${field.key}`}
      >
        <div>
          <div className="lb">{field.label}</div>
          <div className="ds" data-testid={`risk-help-${field.key}`}>
            {field.desc}
          </div>
        </div>
        <div className="ctl">
          <span className="seg tgl">
            <button
              className={value === 'true' ? 'on' : ''}
              onClick={() => onChange('true')}
              type="button"
              data-testid={`risk-${field.key}-on`}
            >
              On
            </button>
            <button
              className={value === 'false' ? 'on' : ''}
              onClick={() => onChange('false')}
              type="button"
              data-testid={`risk-${field.key}-off`}
            >
              Off
            </button>
          </span>
        </div>
      </div>
    );
  }
  return (
    <div
      className={`set ${changed ? 'changed' : ''} ${risky ? 'up' : ''}`}
      data-testid={`risk-row-${field.key}`}
    >
      <div>
        <div className="lb">{field.label}</div>
        <div className="ds" data-testid={`risk-help-${field.key}`}>
          {field.desc}
        </div>
      </div>
      <div className="ctl">
        {field.min !== undefined && field.max !== undefined && (
          <input
            type="range"
            min={field.min}
            max={field.max}
            step={field.step ?? 1}
            value={value}
            onChange={(event) => onChange(event.target.value)}
          />
        )}
        <input
          className="inp num"
          type="number"
          min={field.min}
          max={field.max}
          step={field.step ?? 1}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          data-testid={`risk-${field.key}`}
        />
        <span className="u">{field.unit}</span>
      </div>
    </div>
  );
}
