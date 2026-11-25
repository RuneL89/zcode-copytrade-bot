/**
 * Helius credit governor.
 *
 * Every paid call is a `spend` against one path bucket. Roster and exit
 * buckets are ring-fenced: nothing else can borrow from them, and the degrade
 * ladder cannot pause them. `getTransactionsForAddress` (10 credits per 100
 * full transactions) is rejected on every path except vetting and agent
 * deep-dives — it is banned from timer loops. The nominal-day plan is the
 * call pattern CI asserts against the free-plan budget.
 */

export type HeliusMethod =
  | 'getTransaction'
  | 'getSignaturesForAddress'
  | 'getTransactionsForAddress'
  | 'getSlot'
  | 'getBalance'
  | 'getTokenAccountBalance'
  | 'getTokenAccountsByOwner'
  | 'getAccountInfo'
  | 'getLatestBlockhash'
  | 'getSignatureStatuses'
  | 'sendTransaction'
  /** 2 credits per 0.1 MB of WebSocket payload. `units` is the chunk count. */
  | 'wssChunk';

/** Credits per call. `getTransactionsForAddress` is priced per 100 full txs, which is one page. */
export const METHOD_CREDITS: Record<HeliusMethod, number> = {
  getTransaction: 1,
  getSignaturesForAddress: 1,
  getTransactionsForAddress: 10,
  getSlot: 1,
  getBalance: 1,
  getTokenAccountBalance: 1,
  getTokenAccountsByOwner: 1,
  getAccountInfo: 1,
  getLatestBlockhash: 1,
  getSignatureStatuses: 1,
  sendTransaction: 1,
  wssChunk: 2,
};

export type CreditPath =
  'roster' | 'exit' | 'wallet' | 'watch' | 'vetting' | 'agent' | 'token' | 'health' | 'outage';

export interface PathBudget {
  capPerDay: number;
  expectedPerDay: number;
  /** Exempt paths are never paused and cannot be borrowed from. */
  exempt: boolean;
}

/**
 * Daily buckets. Caps excluding `outage` sum to 13,600. Expected sums to
 * 5,796. Outage is a month-reserve overdraft used only while the roster
 * stream is down, and it is not part of the 13,600 hard cap.
 */
export const PATH_BUDGETS: Record<CreditPath, PathBudget> = {
  roster: { capPerDay: 4_000, expectedPerDay: 2_000, exempt: true },
  exit: { capPerDay: 1_500, expectedPerDay: 300, exempt: true },
  wallet: { capPerDay: 500, expectedPerDay: 300, exempt: false },
  watch: { capPerDay: 2_500, expectedPerDay: 800, exempt: false },
  // Pre-hire reads: the admission scan's detail reads (one candidate per watch
  // tick) and the manual full-history deep-dive. Keeping them off `watch` is
  // what lets a day of deep scans run without pausing the watch-list fallback.
  vetting: { capPerDay: 3_000, expectedPerDay: 1_500, exempt: false },
  agent: { capPerDay: 1_500, expectedPerDay: 600, exempt: false },
  token: { capPerDay: 500, expectedPerDay: 200, exempt: false },
  health: { capPerDay: 100, expectedPerDay: 96, exempt: false },
  outage: { capPerDay: 6_000, expectedPerDay: 0, exempt: true },
};

export const DAILY_HARD_CAP = 13_600;
export const EXPECTED_DAILY = 5_796;
export const MONTH_DAYS = 30;
export const MONTH_AMBER = 450_000;
export const MONTH_RED = 550_000;
/** 60% of the 1M free plan. Projected months above this fail CI. */
export const MONTH_ROSTER_ONLY = 600_000;
export const MONTH_EXITS_ONLY = 900_000;
export const FREE_PLAN_CREDITS = 1_000_000;

/** One `getSlot` every 15 minutes. A 60s loop would be 1,440 samples and is rejected. */
export const HEALTH_INTERVAL_MS = 15 * 60 * 1000;

export const FULL_HISTORY_PATHS: ReadonlySet<CreditPath> = new Set(['vetting', 'agent']);

export type LadderLevel = 'green' | 'amber' | 'red' | 'roster-only' | 'exits-only';

const LADDER_ORDER: LadderLevel[] = ['green', 'amber', 'red', 'roster-only', 'exits-only'];

export type SpendDenyReason = 'banned_method' | 'path_cap' | 'paused' | 'backoff' | 'month_ceiling';

export interface SpendRequest {
  path: CreditPath;
  method: HeliusMethod;
  atMs: number;
  /** Multiplier on METHOD_CREDITS. WSS uses this as the 0.1 MB chunk count. */
  units?: number;
  /** True when this Helius call is a fallback from a failed public RPC. */
  fallback?: boolean;
  /** Optional per-wallet (or other) ceiling inside the path bucket. */
  subBucket?: { key: string; cap: number };
}

export interface SpendDecision {
  ok: boolean;
  credits: number;
  path: CreditPath;
  method: HeliusMethod;
  level: LadderLevel;
  reason?: SpendDenyReason;
}

export interface LedgerRow {
  ts: number;
  path: CreditPath;
  method: HeliusMethod;
  credits: number;
  /** Helius-style cycle id, `YYYY-MM` in the configured offset. */
  cycle: string;
}

export interface BudgetSnapshot {
  byPath: Record<CreditPath, number>;
  dayTotal: number;
  month: number;
  level: LadderLevel;
  ledger: LedgerRow[];
}

export function summedDailyCap(includeOutage = false): number {
  let n = 0;
  for (const [path, budget] of Object.entries(PATH_BUDGETS) as [CreditPath, PathBudget][]) {
    if (!includeOutage && path === 'outage') continue;
    n += budget.capPerDay;
  }
  return n;
}

export function summedExpected(): number {
  let n = 0;
  for (const budget of Object.values(PATH_BUDGETS)) n += budget.expectedPerDay;
  return n;
}

export function healthSamplesPerDay(intervalMs = HEALTH_INTERVAL_MS, dayMs = 86_400_000): number {
  if (intervalMs <= 0) throw new Error('healthSamplesPerDay: interval must be positive');
  return Math.floor(dayMs / intervalMs);
}

/** Local calendar day. `offsetMin` is the operator's zone offset from UTC. */
export function dayKey(atMs: number, offsetMin = 0): string {
  return new Date(atMs + offsetMin * 60_000).toISOString().slice(0, 10);
}

export function cycleKey(atMs: number, offsetMin = 0): string {
  return dayKey(atMs, offsetMin).slice(0, 7);
}

export function assertProjectedMonth(credits: number, ceiling = MONTH_ROSTER_ONLY): void {
  if (!Number.isFinite(credits) || credits < 0) {
    throw new Error(`projected monthly Helius spend is not a usable number: ${credits}`);
  }
  if (credits > ceiling) {
    throw new Error(`projected monthly Helius spend ${credits} exceeds the ${ceiling} ceiling`);
  }
}

export interface UsageReconciliation {
  /** The governor trusts the higher figure. */
  used: number;
  driftPct: number | null;
  alert: boolean;
}

/** Alert when the in-app meter and the Helius-reported figure diverge by more than 10%. */
export function reconcileUsage(metered: number, reported: number | null): UsageReconciliation {
  if (reported === null) return { used: metered, driftPct: null, alert: false };
  const used = Math.max(metered, reported);
  const base = Math.max(Math.min(metered, reported), 1);
  const driftPct = Math.abs(reported - metered) / base;
  return { used, driftPct, alert: driftPct > 0.1 };
}

function worse(a: LadderLevel, b: LadderLevel): LadderLevel {
  return LADDER_ORDER.indexOf(a) >= LADDER_ORDER.indexOf(b) ? a : b;
}

const EMPTY_PATHS = (): Record<CreditPath, number> => ({
  roster: 0,
  exit: 0,
  wallet: 0,
  watch: 0,
  vetting: 0,
  agent: 0,
  token: 0,
  health: 0,
  outage: 0,
});

/**
 * Health sits at 96 of a 100 cap by design (four samples of headroom). Folding
 * it into the 75% amber rule would paint every normal day amber and cut the
 * watch fallback. Amber still trips on every other non-exempt path, and health
 * still hard-stops at its own cap.
 *
 * `vetting` is not an amber-ratio path either: since 2026-11-24 it carries the
 * admission scans, which are the funnel's normal work. A day of deep scans
 * must not trip the ladder that switches the watch list to public RPC. Vetting
 * still hard-stops at its own cap and still pauses at red.
 */
const AMBER_RATIO_PATHS: CreditPath[] = ['wallet', 'watch', 'agent', 'token'];

const RED_PAUSED: ReadonlySet<CreditPath> = new Set(['vetting', 'agent', 'token', 'wallet']);

export class CreditGovernor {
  private ledger: LedgerRow[] = [];
  private dayTotals = new Map<string, number>();
  private monthTotals = new Map<string, number>();
  private subTotals = new Map<string, number>();
  private reportedMonth: number | null = null;
  private backoffUntil = new Map<CreditPath, number>();
  private backoffDelay = new Map<CreditPath, number>();

  constructor(private opts?: { offsetMin?: number; caps?: Partial<Record<CreditPath, number>> }) {}

  private offset(): number {
    return this.opts?.offsetMin ?? 0;
  }

  cap(path: CreditPath): number {
    return this.opts?.caps?.[path] ?? PATH_BUDGETS[path].capPerDay;
  }

  /** Helius Admin API figure. The ladder and `monthUsed` trust the higher number. */
  setReportedUsage(credits: number | null): void {
    this.reportedMonth = credits;
  }

  daySpend(path: CreditPath, atMs: number): number {
    return this.dayTotals.get(`${dayKey(atMs, this.offset())}:${path}`) ?? 0;
  }

  monthMetered(atMs: number): number {
    return this.monthTotals.get(cycleKey(atMs, this.offset())) ?? 0;
  }

  monthUsed(atMs: number): number {
    const metered = this.monthMetered(atMs);
    return this.reportedMonth === null ? metered : Math.max(metered, this.reportedMonth);
  }

  level(atMs: number): LadderLevel {
    let level: LadderLevel = 'green';
    const month = this.monthUsed(atMs);
    if (month >= MONTH_EXITS_ONLY) level = worse(level, 'exits-only');
    else if (month >= MONTH_ROSTER_ONLY) level = worse(level, 'roster-only');
    else if (month >= MONTH_RED) level = worse(level, 'red');
    else if (month >= MONTH_AMBER) level = worse(level, 'amber');

    for (const path of AMBER_RATIO_PATHS) {
      const spent = this.daySpend(path, atMs);
      const cap = this.cap(path);
      if (spent >= cap) level = worse(level, 'red');
      else if (spent >= Math.floor(cap * 0.75)) level = worse(level, 'amber');
    }
    if (this.daySpend('health', atMs) >= this.cap('health')) level = worse(level, 'red');
    return level;
  }

  /**
   * Record a 429. Non-exempt paths then refuse spends until a jittered backoff
   * (1s, doubling, capped at 30s) elapses. Exit, roster, and outage do not
   * enter that denial — an exit under throttling is retried by the caller,
   * never dropped because the governor went quiet.
   */
  note429(path: CreditPath, atMs: number): void {
    if (PATH_BUDGETS[path].exempt) return;
    const prev = this.backoffDelay.get(path) ?? 1_000;
    const delay = Math.min(30_000, prev);
    this.backoffUntil.set(path, atMs + delay);
    this.backoffDelay.set(path, Math.min(30_000, delay * 2));
  }

  private denial(req: SpendRequest, level: LadderLevel, reason: SpendDenyReason, credits = 0): SpendDecision {
    return { ok: false, credits, path: req.path, method: req.method, level, reason };
  }

  spend(req: SpendRequest): SpendDecision {
    const units = req.units ?? 1;
    if (!Number.isInteger(units) || units <= 0) {
      throw new Error(`spend: units must be a positive integer, got ${units}`);
    }
    const credits = METHOD_CREDITS[req.method] * units;
    const level = this.level(req.atMs);

    if (req.method === 'getTransactionsForAddress' && !FULL_HISTORY_PATHS.has(req.path)) {
      return this.denial(req, level, 'banned_method');
    }

    if (!PATH_BUDGETS[req.path].exempt) {
      const until = this.backoffUntil.get(req.path) ?? 0;
      if (req.atMs < until) return this.denial(req, level, 'backoff');
    }

    if (this.paused(req, level)) return this.denial(req, level, 'paused');

    const spent = this.daySpend(req.path, req.atMs);
    if (spent + credits > this.cap(req.path)) return this.denial(req, level, 'path_cap');

    const subKey = req.subBucket
      ? `${dayKey(req.atMs, this.offset())}:${req.path}:${req.subBucket.key}`
      : null;
    if (req.subBucket && subKey) {
      const used = this.subTotals.get(subKey) ?? 0;
      if (used + credits > req.subBucket.cap) return this.denial(req, level, 'path_cap');
    }

    // A non-exempt spend that would push the trusted month figure over the
    // exits-only line is refused. Exempt paths keep their own daily caps.
    if (!PATH_BUDGETS[req.path].exempt && this.monthUsed(req.atMs) >= MONTH_EXITS_ONLY) {
      return this.denial(req, level, 'month_ceiling');
    }

    this.backoffDelay.set(req.path, 1_000);
    const cycle = cycleKey(req.atMs, this.offset());
    const day = `${dayKey(req.atMs, this.offset())}:${req.path}`;
    this.dayTotals.set(day, (this.dayTotals.get(day) ?? 0) + credits);
    this.monthTotals.set(cycle, (this.monthTotals.get(cycle) ?? 0) + credits);
    if (subKey) this.subTotals.set(subKey, (this.subTotals.get(subKey) ?? 0) + credits);
    this.ledger.push({
      ts: req.atMs,
      path: req.path,
      method: req.method,
      credits,
      cycle,
    });
    return { ok: true, credits, path: req.path, method: req.method, level: this.level(req.atMs) };
  }

  private paused(req: SpendRequest, level: LadderLevel): boolean {
    if (PATH_BUDGETS[req.path].exempt) return false;
    if (req.path === 'health') return level === 'roster-only' || level === 'exits-only';
    if (level === 'roster-only' || level === 'exits-only') return true;
    if (level === 'red' && RED_PAUSED.has(req.path)) return true;
    // Watch Helius is fallback-only. Amber and above leave the shadow on public RPC.
    if (req.path === 'watch' && level !== 'green') return true;
    if (req.fallback && req.path === 'watch' && level !== 'green') return true;
    return false;
  }

  snapshot(atMs: number): BudgetSnapshot {
    const byPath = EMPTY_PATHS();
    const day = dayKey(atMs, this.offset());
    let dayTotal = 0;
    for (const row of this.ledger) {
      if (dayKey(row.ts, this.offset()) !== day) continue;
      byPath[row.path] += row.credits;
      dayTotal += row.credits;
    }
    return {
      byPath,
      dayTotal,
      month: this.monthUsed(atMs),
      level: this.level(atMs),
      ledger: this.ledger.slice(),
    };
  }
}

export class GovernedSpendError extends Error {
  constructor(readonly decision: SpendDecision) {
    super(`helius spend denied: ${decision.reason ?? 'unknown'}`);
    this.name = 'GovernedSpendError';
  }
}

function is429(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('429');
}

/**
 * Gate a single outbound call. The send function is not invoked when the
 * governor refuses, so a denied or backed-off call cannot reach Helius.
 */
export async function governedCall<T>(args: {
  governor: CreditGovernor;
  path: CreditPath;
  method: HeliusMethod;
  atMs: number;
  units?: number;
  fallback?: boolean;
  send: () => Promise<T>;
}): Promise<T> {
  const decision = args.governor.spend({
    path: args.path,
    method: args.method,
    atMs: args.atMs,
    units: args.units,
    fallback: args.fallback,
  });
  if (!decision.ok) throw new GovernedSpendError(decision);
  try {
    return await args.send();
  } catch (error) {
    if (is429(error)) args.governor.note429(args.path, args.atMs);
    throw error;
  }
}

export interface PlannedCall {
  path: CreditPath;
  method: HeliusMethod;
  count: number;
  units?: number;
  fallback?: boolean;
}

/**
 * The designed day: push for five seats, signature safety poll, filtered
 * fetches, public-RPC-first watch and wallet, vetting pages, and 96 health
 * samples. Totals are the budget table's expected column (5,796).
 */
export function nominalDayPlan(): PlannedCall[] {
  return [
    // 5 seats × 288 polls (every 5 min) of getSignaturesForAddress.
    { path: 'roster', method: 'getSignaturesForAddress', count: 5 * 288 },
    // Only logs that name a swap program become a getTransaction. 40 per seat.
    { path: 'roster', method: 'getTransaction', count: 5 * 40 },
    // 180 × 0.1 MB of logsSubscribe payload → 360 credits.
    { path: 'roster', method: 'wssChunk', count: 1, units: 180 },
    { path: 'exit', method: 'getSignatureStatuses', count: 300 },
    { path: 'wallet', method: 'getBalance', count: 300, fallback: true },
    { path: 'watch', method: 'getSignaturesForAddress', count: 800, fallback: true },
    { path: 'vetting', method: 'getTransactionsForAddress', count: 150 },
    { path: 'agent', method: 'getTransactionsForAddress', count: 60 },
    { path: 'token', method: 'getAccountInfo', count: 200 },
    { path: 'health', method: 'getSlot', count: healthSamplesPerDay() },
  ];
}

/**
 * Signature-first fallback while both WebSocket connections are down.
 * Unseen swap fetches are listed first so a bucket that runs out still
 * contains both methods, and never a full-history call.
 */
export function streamOutagePlan(hours = 24): PlannedCall[] {
  const ticks = Math.floor((hours * 3_600) / 45);
  return [
    { path: 'outage', method: 'getTransaction', count: 5 * 2 * hours },
    { path: 'outage', method: 'getSignaturesForAddress', count: 5 * ticks },
  ];
}

export function applyPlan(governor: CreditGovernor, plan: PlannedCall[], atMs: number): SpendDecision[] {
  const decisions: SpendDecision[] = [];
  for (const item of plan) {
    for (let i = 0; i < item.count; i++) {
      decisions.push(
        governor.spend({
          path: item.path,
          method: item.method,
          atMs,
          units: item.units,
          fallback: item.fallback,
        }),
      );
    }
  }
  return decisions;
}

export function planCredits(plan: PlannedCall[]): number {
  let n = 0;
  for (const item of plan) n += METHOD_CREDITS[item.method] * (item.units ?? 1) * item.count;
  return n;
}

/** Client-side Helius rate lanes: 10 req/s, 3 reserved for exits, background held to 5. */
export class RateLanes {
  private stamps: { lane: 'exit' | 'background'; atMs: number }[] = [];

  constructor(
    private windowMs = 1_000,
    private total = 10,
    private backgroundMax = 5,
    private exitReserve = 3,
  ) {}

  tryAcquire(lane: 'exit' | 'background', atMs: number): boolean {
    this.stamps = this.stamps.filter((stamp) => atMs - stamp.atMs < this.windowMs);
    const background = this.stamps.filter((stamp) => stamp.lane === 'background').length;
    const used = this.stamps.length;
    if (lane === 'background') {
      if (background >= this.backgroundMax) return false;
      if (used >= this.total - this.exitReserve) return false;
    } else if (used >= this.total) {
      return false;
    }
    this.stamps.push({ lane, atMs });
    return true;
  }
}

export interface StormResult {
  hours: number;
  exitsAttempted: number;
  exitsCompleted: number;
  exitsQueued: number;
  chairsFrozen: number;
  exitBackoffDenials: number;
  backgroundSent: number;
  backgroundBackedOff: number;
  backgroundDeniedByBackoff: number;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 12h with a 429 on 66% of attempts. Exits retry with jitter and land in the
 * exit queue rather than freezing a chair. Background paths back off.
 */
export function run429Storm(opts?: { hours?: number; seed?: number }): StormResult {
  const hours = opts?.hours ?? 12;
  const rng = mulberry32(opts?.seed ?? 0x4e0e);
  const governor = new CreditGovernor({
    caps: { watch: 10_000_000, exit: 10_000_000, roster: 10_000_000 },
  });
  const lanes = new RateLanes();
  const chairs = [0, 1, 2, 3, 4].map((id) => ({
    id,
    state: 'open' as 'open' | 'completed' | 'queued',
    frozen: false,
    nextRetryMs: 0,
  }));
  let exitsAttempted = 0;
  let exitBackoffDenials = 0;
  let backgroundSent = 0;
  let backgroundBackedOff = 0;
  let backgroundDeniedByBackoff = 0;
  const end = hours * 3_600_000;

  // Half-second ticks so a 1s backoff actually covers the next attempt.
  for (let t = 0; t < end; t += 500) {
    const background = governor.spend({
      path: 'watch',
      method: 'getSignaturesForAddress',
      atMs: t,
      fallback: true,
    });
    if (!background.ok && background.reason === 'backoff') {
      backgroundDeniedByBackoff++;
    } else if (background.ok && lanes.tryAcquire('background', t)) {
      if (rng() < 0.66) {
        governor.note429('watch', t);
        backgroundBackedOff++;
      } else {
        backgroundSent++;
      }
    }

    for (const chair of chairs) {
      if (chair.state !== 'open' || t < chair.nextRetryMs) continue;
      exitsAttempted++;
      const decision = governor.spend({ path: 'exit', method: 'getSignatureStatuses', atMs: t });
      if (!decision.ok && decision.reason === 'backoff') {
        exitBackoffDenials++;
        chair.state = 'queued';
        continue;
      }
      if (!decision.ok) {
        chair.state = 'queued';
        continue;
      }
      if (!lanes.tryAcquire('exit', t)) {
        chair.nextRetryMs = t + 1_000;
        continue;
      }
      if (rng() < 0.66) {
        governor.note429('exit', t);
        const jitter = 1_000 + Math.floor(rng() * 29_000);
        chair.nextRetryMs = t + jitter;
      } else {
        chair.state = 'completed';
      }
    }
  }

  for (const chair of chairs) {
    if (chair.state === 'open') chair.state = 'queued';
  }

  return {
    hours,
    exitsAttempted,
    exitsCompleted: chairs.filter((chair) => chair.state === 'completed').length,
    exitsQueued: chairs.filter((chair) => chair.state === 'queued').length,
    chairsFrozen: chairs.filter((chair) => chair.frozen).length,
    exitBackoffDenials,
    backgroundSent,
    backgroundBackedOff,
    backgroundDeniedByBackoff,
  };
}

export class WatchListFullError extends Error {
  constructor(
    readonly cap: number,
    readonly size: number,
  ) {
    super(`watch list is full (${size}/${cap})`);
    this.name = 'WatchListFullError';
  }
}

/** Hard cap. Admitting past the cap throws; hired seats are not part of this set. */
export class WatchListCap {
  private ids = new Set<string>();

  constructor(private cap: number) {
    if (!Number.isInteger(cap) || cap <= 0) throw new Error('WatchListCap: cap must be a positive integer');
  }

  get size(): number {
    return this.ids.size;
  }

  admit(id: string): void {
    if (this.ids.has(id)) return;
    if (this.ids.size >= this.cap) throw new WatchListFullError(this.cap, this.ids.size);
    this.ids.add(id);
  }
}

export type JupiterLane = 'exit' | 'entry' | 'mark' | 'paper' | 'shadow' | 'price';

const JUPITER_RANK: Record<JupiterLane, number> = {
  exit: 0,
  entry: 1,
  mark: 2,
  paper: 3,
  shadow: 4,
  price: 5,
};

/**
 * Free Jupiter key is about 1 request/second shared by every lane.
 * A waiting exit sheds a shadow or price request instead of queueing behind it.
 */
export class JupiterScheduler {
  private lastMs = Number.NEGATIVE_INFINITY;
  private waiting: JupiterLane | null = null;

  request(lane: JupiterLane, atMs: number): 'sent' | 'shed' | 'wait' {
    if (this.waiting !== null && JUPITER_RANK[lane] < JUPITER_RANK[this.waiting]) {
      if (this.waiting === 'shadow' || this.waiting === 'price') this.waiting = lane;
    }
    const due = this.waiting === null || JUPITER_RANK[lane] <= JUPITER_RANK[this.waiting];
    if (!due) return 'shed';
    if (atMs - this.lastMs < 1_000) {
      if (lane === 'shadow' || lane === 'price') return 'shed';
      this.waiting = lane;
      return 'wait';
    }
    this.lastMs = atMs;
    this.waiting = null;
    return 'sent';
  }
}
