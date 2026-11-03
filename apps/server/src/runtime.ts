import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, watch } from 'node:fs';
import { join } from 'node:path';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { settingsPatchSchema, SETTINGS_PATCH_KEYS, type AppConfig } from '@zcode-bot/config';
import { openDatabase, acquireWorkerLock, type DbHandle, type WorkerLock } from '@zcode-bot/db';
import * as repo from '@zcode-bot/db/repo.js';
import {
  DEFAULT_FOMO_CONFIG,
  DawnNeedsLoginError,
  DawnNoCardError,
  DawnTraderLookupProvider,
  FomoApiClient,
  FomoWebLeaderboardProvider,
  HeliusProvider,
  JupiterProvider,
  JupiterPriceProvider,
  PublicSolanaProvider,
  notifierFromEnv,
  StaticPriceProvider,
  type DawnLookupConfig,
  type FomoWebConfig,
  type Notifier,
  type PersonalProfileSyncOptions,
} from '@zcode-bot/providers';
import { StateStore } from './services/state.js';
import { ControlService } from './services/control.js';
import { CopyEngine, SOL_MINT, USDC_MINT } from './services/engine.js';
import { TraderLifecycle } from './services/lifecycle.js';
import { LeaderMonitor, reconcileOpenIntents } from './services/monitor.js';
import { selectDawnTargets } from './services/dawn-targets.js';
import { WithdrawalService, createSolanaBroadcaster, heliusRpcUrl } from './services/withdraw.js';
import { checkWalletActivity } from './services/activity-check.js';
import { isDawnParked } from './services/dawn-park.js';
import { StateBuilder } from './services/builder.js';
import { readinessReport } from './services/readiness.js';
import { DemoEngine, defaultFixturesPath } from './services/demo.js';
import { OpsRunner } from './services/ops.js';
import { DiscoveryService, discoveryDecision } from './services/discovery.js';
import { WatchService } from './services/watch.js';
import { ReportsService } from './services/reports.js';
import { FeeLedgerService } from './services/fee-ledger.js';
import { TokenMetaService } from './services/token-meta.js';
import { PaperExecutor, LiveExecutor } from './services/executors.js';
import { loadWalletSecret, walletPublicKey } from './wallet.js';
import { readRememberedPassphrase } from './wallet-unlock.js';
import { REPO_ROOT, migrationsFolder } from './bootstrap.js';

const repoRoot = REPO_ROOT;

export interface SetupToken {
  value: string;
  expiresAt: number;
}

/** Politeness pacing between provider calls inside refresh loops. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runtime wires every service together. One process = one worker (exclusive
 * lock) + HTTP server. Demo mode short-circuits providers for a purely
 * fictional, in-memory replay.
 */
export class Runtime {
  db: DbHandle;
  lock: WorkerLock | null = null;
  control: ControlService;
  store = new StateStore();
  helius: HeliusProvider;
  /** Free public RPC for the candidate activity refresh; monitor never uses it. */
  publicSolana: PublicSolanaProvider;
  jupiter: JupiterProvider;
  notifier: Notifier;
  feeLedger: FeeLedgerService;
  tokenMeta: TokenMetaService;
  engine: CopyEngine;
  lifecycle: TraderLifecycle;
  monitor: LeaderMonitor | null = null;
  builder: StateBuilder;
  withdraw: WithdrawalService;
  demo: DemoEngine | null = null;
  ops: OpsRunner;
  /** Telegram push reports: anomalies + daily PnL (no-op until TELEGRAM_* is set). */
  reports: ReportsService;
  private priceProvider: import('@zcode-bot/providers').PriceProvider;
  /** Read-only FOMO leaderboard adapter; null until FOMO_LEADERBOARD_URL is set. */
  fomoWeb: FomoWebLeaderboardProvider | null = null;
  /** fomoapi.io discovery inlet (D3) — the only automatic handle/wallet source. */
  discovery: DiscoveryService;
  /** Watch list + shadow ledger (D4): the observation record promotion reads. */
  watch: WatchService;
  private watchTimer: ReturnType<typeof setInterval> | null = null;
  private rosterTimer: ReturnType<typeof setInterval> | null = null;
  /** Last cooling rotation scan (folded into the watch clock, D4's 2h rotation). */
  private lastCoolingScanAt = 0;
  private watchBootTimer: ReturnType<typeof setTimeout> | null = null;
  /** Read-only Dawn (Telegram) trader-lookup adapter; null until DAWN_BOT_USERNAME is set. */
  dawnLookup: DawnTraderLookupProvider | null = null;
  private dawnRunBusy = false;
  private activityTimer: ReturnType<typeof setInterval> | null = null;
  private activityBootTimer: ReturnType<typeof setTimeout> | null = null;
  private setupToken: SetupToken | null = null;
  private baseExecutor: PaperExecutor;
  private liveExecutor: LiveExecutor | null = null;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  /** Set by stop(): async probes must not touch the closed database after that. */
  private stopping = false;
  private symbolTimer: ReturnType<typeof setTimeout> | null = null;
  private feeLedgerTimer: ReturnType<typeof setInterval> | null = null;
  private lastFeeScanAt = 0;
  private solPriceUsdMicro: bigint | null = null;

  private equityStartUsdMicro: bigint;

  constructor(
    public config: AppConfig,
    equityStartOverride?: bigint,
  ) {
    // Paper equity baseline: EQUITY_START_USD (operator-set) or $1,000 default.
    this.equityStartUsdMicro =
      equityStartOverride ??
      (config.env.EQUITY_START_USD != null
        ? BigInt(Math.round(config.env.EQUITY_START_USD * 1_000_000))
        : 1_000_000_000n);
    this.db = openDatabase(config.env.DATA_DIR);
    migrate(this.db.db, { migrationsFolder: migrationsFolder() });
    // Dashboard risk overrides persist in kv; re-apply them (validated) so
    // settings changes survive a restart. The saved blob is a FULL RiskConfig
    // (applySettings stores the merged config), so unknown keys are stripped
    // before validating against the patch schema — a strict parse of the whole
    // blob would always fail and silently discard operator settings.
    const savedOverrides = repo.kvGet(this.db.db, 'risk.overrides');
    if (savedOverrides) {
      try {
        const raw = JSON.parse(savedOverrides) as Record<string, unknown>;
        const patch: Record<string, unknown> = {};
        // Only keys the patch schema knows survive: the blob is a full config,
        // and a strict parse of unknown fields would discard every override.
        for (const key of SETTINGS_PATCH_KEYS) {
          if (key in raw) patch[key] = raw[key];
        }
        Object.assign(config.risk, settingsPatchSchema.parse(patch));
      } catch (e) {
        // Invalid overrides: keep them on disk (never destroy operator data),
        // continue with env/defaults, and surface the problem.
        repo.audit(
          this.db.db,
          'settings',
          'saved risk overrides invalid — using env/defaults (overrides kept on disk): ' +
            (e as Error).message,
          {},
        );
      }
    }
    this.control = new ControlService(this.db.db, config.env.DATA_DIR);
    this.helius = new HeliusProvider(config.env.HELIUS_API_KEY);
    // Empty PUBLIC_SOLANA_RPC_URL disables the free path (configured=false) and
    // the activity refresh falls back to Helius entirely.
    this.publicSolana = new PublicSolanaProvider(config.env.PUBLIC_SOLANA_RPC_URL, 4, this.helius);
    this.jupiter = new JupiterProvider(config.env.JUPITER_BASE_URL, config.env.JUPITER_API_KEY);
    this.notifier = notifierFromEnv(config.env.TELEGRAM_BOT_TOKEN, config.env.TELEGRAM_CHAT_ID);
    this.feeLedger = new FeeLedgerService(this.db.db, this.helius);
    this.tokenMeta = new TokenMetaService(this.db.db, this.helius);

    // Pricer: real quotes in paper/live; static deterministic prices in demo.
    const prices =
      config.mode === 'demo'
        ? new StaticPriceProvider(new Map([['So11111111111111111111111111111111111111112', 180_000_000n]]))
        : new JupiterPriceProvider(this.jupiter, config.risk.PRICE_MAX_AGE_SECONDS * 1000);
    this.priceProvider = prices;

    this.baseExecutor = new PaperExecutor(this.jupiter, async (mint, decimals) => {
      const p = await (
        prices as { priceOf(m: string, d: number): Promise<{ priceUsdMicro: bigint }> }
      ).priceOf(mint, decimals);
      return p.priceUsdMicro;
    });

    this.engine = new CopyEngine(
      this.db.db,
      config.risk,
      prices,
      this.baseExecutor,
      this.control,
      this.notifier,
      {
        onFired: (activationId, _firedCandidateId, reason) => {
          // lifecycle.fire moves the leader to cooling itself, so every firing
          // path (idle, stall, manual, loss streak) takes the same hand-off.
          void this.lifecycle.fire(activationId, reason).then(() => {
            // D5: a freed chair must not wait for the next watch tick — ask
            // discovery for a fresh bench right away (rate-limited inside).
            this.maybeDemandDiscovery();
            this.rebuildState();
          });
        },
        onStateChanged: () => {
          this.rebuildState();
          // A new position lands here first: resolve its ticker off the hot
          // path so the dashboard shows a symbol instead of a mint fragment.
          this.scheduleSymbolResolve();
          // Re-price SOL spend right after a trade, but never more than once
          // every five minutes (history calls are billed).
          void this.refreshFeeLedger(5 * 60_000).catch(() => undefined);
        },
      },
      walletPublicKey(config.env.DATA_DIR),
      this.equityStartUsdMicro,
      config.mode === 'live',
    );

    this.lifecycle = new TraderLifecycle(this.db.db, config.risk, this.engine);
    this.engineCallbacks();

    this.builder = new StateBuilder(
      this.db.db,
      config,
      this.control,
      null,
      this.lifecycle,
      this.equityStartUsdMicro,
    );

    this.withdraw = new WithdrawalService(
      this.db.db,
      config,
      this.control,
      this.helius,
      this.equityStartUsdMicro,
      createSolanaBroadcaster(() => heliusRpcUrl(this.config.env.HELIUS_API_KEY)),
    );

    if (config.mode === 'demo') {
      this.demo = new DemoEngine(defaultFixturesPath(repoRoot), (state) => this.store.publish(state));
    }

    // Read-only FOMO leaderboard adapter: enabled only when a URL is configured.
    const fomoUrl = config.env.FOMO_LEADERBOARD_URL?.trim();
    if (fomoUrl) {
      // Profile mode 'personal-copy' (owner default): run on a selective copy
      // of the operator's real desktop Chrome profile so Fomo is reached
      // through the EXISTING Google session — no login ceremony. Google
      // refuses OAuth from automation browsers and Chrome 136+ blocks remote
      // debugging on the default profile outright, so a copy is the only way
      // to honor "use my desktop Chrome as default". The copy refreshes
      // whenever the real Chrome is closed; until then the stale copy is
      // used (Fomo session cookies usually outlive it).
      const personalUserDataDir =
        process.env.LOCALAPPDATA != null
          ? join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'User Data')
          : null;
      const personalMode =
        config.env.FOMO_PROFILE_MODE === 'personal-copy' &&
        personalUserDataDir != null &&
        existsSync(personalUserDataDir);
      let personalSync: PersonalProfileSyncOptions | undefined;
      let fomoProfileDir = join(config.env.DATA_DIR, 'browser-profile');
      if (personalMode) {
        fomoProfileDir = join(config.env.DATA_DIR, 'browser-profile-personal');
        personalSync = {
          sourceDir: personalUserDataDir as string,
          copyDir: fomoProfileDir,
          staleAfterMs: 24 * 60 * 60_000,
        };
      }
      const fomoConfig: FomoWebConfig = {
        leaderboardUrl: fomoUrl,
        robotsUrl: config.env.FOMO_ROBOTS_URL?.trim() ?? '',
        profileDir: fomoProfileDir,
        minFetchIntervalMs: 5 * 60_000,
        maxAgeMs: 2 * 60 * 60_000,
        selectors: { ...DEFAULT_FOMO_CONFIG.selectors },
        headless: false, // visible browser
        // Real installed Chrome instead of the automation Chromium: Google
        // refuses OAuth sign-in from the packaged build ("may not be secure").
        channel: config.env.FOMO_BROWSER_CHANNEL,
        profileAddressSelector: config.env.FOMO_PROFILE_ADDRESS_SELECTOR?.trim() || undefined,
        profileScrapeLimit: 10,
        profileDelayMs: 2500,
        personalProfileSync: personalSync,
      };
      if (config.env.FOMO_SELECTORS_JSON?.trim()) {
        try {
          fomoConfig.selectors = {
            ...DEFAULT_FOMO_CONFIG.selectors,
            ...(JSON.parse(config.env.FOMO_SELECTORS_JSON) as Partial<FomoWebConfig['selectors']>),
          };
        } catch {
          repo.audit(this.db.db, 'fomo-web', 'FOMO_SELECTORS_JSON is not valid JSON; using defaults', {});
        }
      }
      this.fomoWeb = new FomoWebLeaderboardProvider(fomoConfig);
    }

    // Read-only Dawn trader lookup: sends "@handle" to the Dawn bot through the
    // operator's own logged-in Telegram Web session and reads the wallet reply.
    const dawnBot = config.env.DAWN_BOT_USERNAME?.trim();
    if (dawnBot) {
      const dawnConfig: DawnLookupConfig = {
        botUsername: dawnBot,
        webAppUrl: config.env.DAWN_WEB_URL,
        profileDir: join(config.env.DATA_DIR, 'browser-profile-dawn'),
        channel: config.env.DAWN_BROWSER_CHANNEL,
        headless: false, // visible browser: the operator scans the QR once, in person
        replyTimeoutMs: 45_000,
        perLookupDelayMs: 20_000,
        // Silent-bot policy: one retry after 30s while Telegram is healthy,
        // then record the handle and move on to the next target.
        noCardRetryDelayMs: 30_000,
        maxNoCardAttempts: 2,
      };
      this.dawnLookup = new DawnTraderLookupProvider(dawnConfig);
    }

    this.ops = new OpsRunner(this, this.db.db, repoRoot);
    // The reports describe the built dashboard state; the marks are refreshed
    // first so unrealized PnL in a report is never silently stale.
    this.reports = new ReportsService(this.db, this.notifier, config.mode, () => this.snapshotForReport());

    // Discovery inlet (D3): the fomoapi leaderboard. No key → the service never
    // calls the API and audits the skip instead.
    this.discovery = new DiscoveryService(
      this.db.db,
      new FomoApiClient({
        baseUrl: config.env.FOMOAPI_BASE_URL,
        apiKey: config.env.FOMOAPI_KEY ?? '',
      }),
      config.risk,
    );
    // The pipeline spine's discovery facts come from the service's own record
    // of its last run (plan 07) — never re-derived.
    this.builder.setDiscoveryStatus(() => this.discovery.status());

    // Watch list + shadow ledger (D4). Promotion hands the wallet to the
    // existing single-chair activation until the roster lands (plan 05).
    this.watch = new WatchService({
      db: this.db.db,
      risk: config.risk,
      publicSolana: this.publicSolana,
      helius: this.helius,
      prices,
      lifecycle: this.lifecycle,
      onStateChanged: () => this.rebuildState(),
    });
  }

  /**
   * The engine's callbacks are wired where the engine is constructed (see the
   * constructor). Nothing patches the lifecycle any more: chairs are filled by
   * the promotion queue (D4/plan 05) and there is no ordering to consult.
   */
  private engineCallbacks(): void {}

  // ---- helpers -------------------------------------------------------------

  /**
   * Rebuild the dashboard state from persisted evidence and publish it to the
   * SSE store. Called after every state-changing action; the research-era
   * snapshot timers it used to share this path with are gone (D6).
   */
  rebuildState(): import('./services/state.js').DashboardState {
    if (this.demo?.running) return this.store.get()!; // demo owns the state while replaying
    // Chairs are filled by the promotion queue (fillRoster from the watch tick
    // and right after a fire), never by a board ordering.
    const state = this.builder.build();
    this.store.publish(state);
    return state;
  }

  /**
   * A state snapshot for an outbound report (Telegram): re-price first, then
   * rebuild, so the figures are current rather than up to a minute old.
   */
  async snapshotForReport(): Promise<import('./services/state.js').DashboardState> {
    await this.refreshMarks().catch(() => undefined);
    return this.rebuildState();
  }

  readiness() {
    return readinessReport(this.db.db, this.config, this.control, this.monitor, Boolean(this.lock));
  }

  private async restoreLiveArming(): Promise<void> {
    if (this.config.mode !== 'live') return;
    if (!this.control.flags.armed) return; // explicit disarm — nothing to restore
    try {
      const passphrase = readRememberedPassphrase(this.config.env.DATA_DIR);
      if (!passphrase) {
        throw new Error('no sealed wallet passphrase on disk — arm once from the dashboard');
      }
      const secret = loadWalletSecret(this.config.env.DATA_DIR, passphrase);
      const publicKey = walletPublicKey(this.config.env.DATA_DIR);
      if (!publicKey) throw new Error('wallet public key missing');
      this.mountLiveExecutor(new LiveExecutor(this.jupiter, this.heliusRpcUrl(), secret, publicKey));
      repo.audit(this.db.db, 'control', 'boot: wallet auto-unlocked — live arming restored', {});
      void this.notifier
        .notify('Copydesk restarted — wallet auto-unlocked, LIVE still armed. No action needed.')
        .catch(() => {});
    } catch (e) {
      const reason = (e as Error).message;
      this.control.bootDisarm(reason);
      void this.notifier
        .notify(`⚠️ Copydesk restarted and is DISARMED: ${reason}. Re-arm in the dashboard.`)
        .catch(() => {});
    }
  }

  /**
   * Start the runtime (plan 06): the DEMAND-DRIVEN scheduler.
   *
   * Exactly two monitoring clocks exist — the watch list (`WATCH_POLL_MS`) and
   * the roster (the monitor's `ROSTER_POLL_MS`). Everything else below is
   * housekeeping: provider health, the fee ledger, the activity refresh that
   * feeds the stall watcher, symbol resolution and the report schedule. None of
   * them discovers or hires, and only the demand-gated discovery run spends
   * fomoapi credits — a full roster and a full bench cost nothing external.
   *
   * Boot catch-up runs BEFORE the clocks start: discovery when the bench is
   * thin, one watch pass, then the promotion queue fills whatever chairs are
   * free. Demo mode returns earlier and never reaches any of it.
   */
  async start(): Promise<void> {
    this.lock = acquireWorkerLock(this.config.env.DATA_DIR);
    repo.audit(this.db.db, 'system', `runtime starting (mode=${this.config.mode})`);

    const recon = reconcileOpenIntents(this.db.db);
    if (recon.opened > 0) {
      repo.audit(
        this.db.db,
        'reconciliation',
        `startup reconciliation: ${recon.opened} case(s) reviewed`,
        recon,
      );
    }
    await this.restoreLiveArming();
    void this.resolveTokenSymbols().catch(() => undefined);
    void this.refreshFeeLedger().catch(() => undefined);

    // Signature-less reconciliation cases were provably never submitted, so
    // retrying their closes at boot is safe and unsticks a paused chair.
    if (this.config.mode !== 'live' || this.liveExecutor) {
      void this.lifecycle
        .retrySignaturelessCloses('boot_reconciliation_retry')
        .then((r) => {
          if (r.retried > 0) {
            repo.audit(
              this.db.db,
              'reconciliation',
              `boot retry-close: ${r.retried} retried, ${r.closed} closed, ${r.failed} failed, ${r.skipped} skipped`,
              r,
            );
            this.rebuildState();
          }
        })
        .catch((e: Error) => {
          repo.audit(this.db.db, 'reconciliation', `boot retry-close failed: ${e.message}`, {});
        });
    }

    if (this.config.mode === 'demo') {
      this.startDemo();
      repo.audit(this.db.db, 'demo', 'fictional demo replay started (no live data, no live tables)');
      return;
    }

    this.monitor = new LeaderMonitor(
      this.db.db,
      this.helius,
      this.engine,
      this.config.risk,
      this.lifecycle,
      () => this.rebuildState(),
      // D5: the roster's own cadence — a real order may follow a leader buy, so
      // a hired wallet is polled every ROSTER_POLL_MS (45 s by default).
      this.config.risk.ROSTER_POLL_MS,
      (positionId) => this.builder.peekMark(positionId),
    );
    // The runtime owns both monitoring clocks (plan 06 AC4); the monitor's own
    // interval stays off.
    this.monitor.start(false);
    // Give the builder the monitor reference now that it exists.
    (this.builder as unknown as { monitor: LeaderMonitor | null }).monitor = this.monitor;

    // Provider health sampler (housekeeping).
    this.healthTimer = setInterval(() => void this.sampleHealth(), 60_000);
    void this.sampleHealth();

    // Fee ledger scan cadence (housekeeping): wallet history is a billed call,
    // so it stays well off the one-minute health loop.
    this.feeLedgerTimer = setInterval(() => void this.refreshFeeLedger(), 10 * 60_000);

    // Candidate-pool activity refresh (housekeeping): keeps the funded-buy
    // readings and the stall watcher's evidence current. Never hires.
    this.activityTimer = setInterval(() => {
      void this.activityRefreshNow().catch((e: Error) => {
        repo.audit(this.db.db, 'activity', 'scheduled activity refresh failed: ' + e.message, {});
      });
    }, this.config.env.ACTIVITY_REFRESH_POLL_MS);
    this.activityBootTimer = setTimeout(() => {
      void this.activityRefreshNow().catch((e: Error) => {
        repo.audit(this.db.db, 'activity', 'boot activity refresh failed: ' + e.message, {});
      });
    }, 120_000);
    repo.audit(
      this.db.db,
      'activity',
      'activity refresh enabled (every ' +
        Math.round(this.config.env.ACTIVITY_REFRESH_POLL_MS / 60000) +
        ' min, max ' +
        this.config.env.ACTIVITY_MAX_PER_RUN +
        ' per run)',
      {},
    );

    // Operator push reports (Telegram): anomalies every 10 min, daily PnL 09:00.
    this.reports.start();

    // BOOT CATCH-UP (D5) — strictly before the two clocks below:
    //   1. demand-gated discovery (a fresh start must not wait for a tick);
    //   2. the persisted bench fills whatever chairs are free (promptly — the
    //      watch pass below can be slow, and a free chair must not wait on it);
    //   3. one watch pass, so the shadow record is current;
    //   4. the promotion queue fills any chair that opened during the pass.
    // The HTTP server is already serving while this runs; only the clocks wait.
    const bootCatchUp = (async () => {
      const bootDiscovery = discoveryDecision(this.discovery.demand());
      if (bootDiscovery.run) {
        await this.syncDiscoveryNow(false).catch((e: Error) => {
          repo.audit(this.db.db, 'discovery', `boot discovery failed (fail closed): ${e.message}`, {});
        });
      } else {
        repo.audit(this.db.db, 'discovery', `boot discovery skipped: ${bootDiscovery.reason}`, {});
      }
      // Seat the persisted bench BEFORE the watch pass: the pass polls every
      // watched wallet and a slow provider once held an open chair for many
      // minutes. Promotion is already recorded on the bench, so filling first
      // changes only how promptly the chair is taken.
      const seatedEarly = await this.lifecycle.fillRoster().catch((e: Error) => {
        repo.audit(this.db.db, 'roster', `boot roster fill (bench) failed: ${e.message}`, {});
        return { hired: [] as string[], reason: 'error' };
      });
      repo.audit(
        this.db.db,
        'roster',
        `boot roster fill (bench): ${seatedEarly.hired.length} hired (${seatedEarly.reason})`,
        { hired: seatedEarly.hired },
      );
      await this.watch.tick().catch((e: Error) => {
        repo.audit(this.db.db, 'watch', `boot watch pass failed (fail closed): ${e.message}`, {});
      });
      const filled = await this.lifecycle.fillRoster().catch((e: Error) => {
        repo.audit(this.db.db, 'roster', `boot roster fill failed: ${e.message}`, {});
        return { hired: [] as string[], reason: 'error' };
      });
      repo.audit(this.db.db, 'roster', `boot roster fill: ${filled.hired.length} hired (${filled.reason})`, {
        hired: filled.hired,
      });
    })();

    // The two INTENTIONAL monitoring clocks (D5): the watch list every
    // WATCH_POLL_MS and the roster on the monitor's ROSTER_POLL_MS.
    void bootCatchUp.finally(() => {
      // The WATCH clock: the shadow record, the promotion/demotion sweep, the
      // demand trigger, and — time-gated rather than on a timer of its own — the
      // slow cooling rotation for fired traders (D4).
      this.watchTimer = setInterval(() => {
        void this.watch
          .tick()
          .then(() => this.maybeDemandDiscovery())
          .then(() => {
            if (Date.now() - this.lastCoolingScanAt < this.config.risk.COOLING_SCAN_MS) return;
            this.lastCoolingScanAt = Date.now();
            return this.watch.coolingTick();
          })
          .catch((e: Error) => {
            repo.audit(this.db.db, 'watch', `watch tick failed (fail closed): ${e.message}`, {});
          });
      }, this.config.risk.WATCH_POLL_MS);
      // The ROSTER clock: every hired wallet, every ROSTER_POLL_MS.
      this.rosterTimer = setInterval(() => {
        void this.monitor?.tick().catch((e: Error) => {
          repo.audit(this.db.db, 'monitor', `roster tick failed (fail closed): ${e.message}`, {});
        });
      }, this.config.risk.ROSTER_POLL_MS);
    });
    repo.audit(
      this.db.db,
      'watch',
      `watch list enabled (poll every ${Math.round(this.config.risk.WATCH_POLL_MS / 60_000)} min, ` +
        `cooling every ${Math.round(this.config.risk.COOLING_SCAN_MS / 3_600_000)}h, ` +
        `roster every ${Math.round(this.config.risk.ROSTER_POLL_MS / 1000)}s)`,
    );

    this.rebuildState();
  }

  stop(): void {
    this.stopping = true;
    this.monitor?.stop();
    this.demo?.stop();
    if (this.healthTimer) clearInterval(this.healthTimer);
    if (this.feeLedgerTimer) clearInterval(this.feeLedgerTimer);
    if (this.symbolTimer) clearTimeout(this.symbolTimer);
    if (this.watchTimer) clearInterval(this.watchTimer);
    if (this.rosterTimer) clearInterval(this.rosterTimer);
    if (this.watchBootTimer) clearTimeout(this.watchBootTimer);
    void this.fomoWeb?.close();
    void this.dawnLookup?.close();
    if (this.activityTimer) clearInterval(this.activityTimer);
    if (this.activityBootTimer) clearTimeout(this.activityBootTimer);
    this.reports.stop();
    this.lock?.release();
    this.db.close();
  }

  async sampleHealth(): Promise<void> {
    // A probe in flight when the process shuts down must not touch the closed
    // database (the boot probe is not awaited).
    if (this.stopping) return;
    try {
      const now = new Date().toISOString();
      const h: { ok: boolean; latencyMs?: number; detail?: string } = this.helius.configured
        ? await this.helius.healthCheck()
        : { ok: false, detail: 'not configured' };
      const j: { ok: boolean; latencyMs?: number; detail?: string } = await this.jupiter
        .healthCheck()
        .catch((e: Error) => ({ ok: false, detail: e.message }));
      repo.recordProviderHealth(this.db.db, {
        provider: 'helius',
        status: this.helius.configured ? (h.ok ? 'ok' : 'down') : 'disabled',
        latencyMs: h.latencyMs ?? null,
        detail: h.detail ?? null,
        checkedAt: now,
      });
      repo.recordProviderHealth(this.db.db, {
        provider: 'jupiter',
        status: j.ok ? 'ok' : 'down',
        latencyMs: j.latencyMs ?? null,
        detail: j.detail ?? null,
        checkedAt: now,
      });
      this.builder.setHealth({
        helius: this.helius.configured ? (h.ok ? 'OK' : 'DOWN') : 'UNCONFIGURED',
        jupiter: j.ok ? 'OK' : 'DOWN',
      });
      await this.refreshMarks().catch(() => undefined);
      // Fee wallet runway: SOL pays every network fee, so surface its balance.
      const feeAddress = walletPublicKey(this.config.env.DATA_DIR);
      const solLamports = feeAddress ? await this.helius.solBalanceLamports(feeAddress) : null;
      let solPriceUsdMicro: bigint | null = null;
      try {
        solPriceUsdMicro = (await this.priceProvider.priceOf(SOL_MINT, 9)).priceUsdMicro;
      } catch {
        solPriceUsdMicro = null;
      }
      this.solPriceUsdMicro = solPriceUsdMicro;
      const solUsdMicro =
        solLamports !== null && solPriceUsdMicro !== null
          ? (BigInt(solLamports) * solPriceUsdMicro) / 10n ** 9n
          : null;
      this.builder.setFeeWallet(solLamports, solUsdMicro);
      // SOL spend is NOT rescanned here: this loop runs every minute and each
      // history call is billed. The ledger refreshes on boot, every 10 minutes,
      // and shortly after a trade instead (see refreshFeeLedger).
      const ledger = this.feeLedger.snapshot();
      this.builder.setFeeLedger({ totals: ledger.totals, tx: ledger.tx, solUsdMicro: solPriceUsdMicro });
      // USDC wallet balance: the withdrawable-cap cross-check for the OPS card.
      const usdcBase = feeAddress ? await this.helius.tokenBalanceBase(USDC_MINT, feeAddress) : null;
      this.builder.setWalletUsdc(usdcBase);
      // Symbols can appear later (a token gains metadata after launch), so keep
      // retrying the ones still missing on the health cadence.
      await this.resolveTokenSymbols().catch(() => undefined);
      this.rebuildState();
    } catch (e) {
      // A probe that loses the database to a shutdown is expected, not a bug.
      if (this.stopping) return;
      throw e;
    }
  }

  /**
   * Price any wallet transactions the ledger has not seen yet.
   *
   * Wallet history is a billed Helius call, so this deliberately does NOT run
   * on the one-minute health loop: it runs at boot, every ten minutes, and
   * once shortly after a trade (throttled). A trade's true fee therefore
   * appears within seconds when there is something new, and the idle steady
   * state costs a few calls per hour instead of 1,440.
   */
  private async refreshFeeLedger(throttleMs = 0): Promise<void> {
    if (this.config.mode === 'demo') return;
    if (throttleMs > 0 && Date.now() - this.lastFeeScanAt < throttleMs) return;
    const feeAddress = walletPublicKey(this.config.env.DATA_DIR);
    if (!feeAddress) return;
    this.lastFeeScanAt = Date.now();
    await this.feeLedger.refresh(feeAddress).catch(() => undefined);
    const snapshot = this.feeLedger.snapshot();
    this.builder.setFeeLedger({
      totals: snapshot.totals,
      tx: snapshot.tx,
      solUsdMicro: this.solPriceUsdMicro,
    });
    this.rebuildState();
  }

  /** Debounced ticker resolution: never blocks an order, never storms the index. */

  private scheduleSymbolResolve(): void {
    if (this.symbolTimer) return;
    this.symbolTimer = setTimeout(() => {
      this.symbolTimer = null;
      void this.resolveTokenSymbols().catch(() => undefined);
    }, 1_500);
  }

  /**
   * Fill in missing token symbols (open and closed positions) from the
   * metadata index. Stores the symbol on the position row so every panel —
   * including the closed-positions list — reads the same value.
   */
  private async resolveTokenSymbols(): Promise<void> {
    if (this.config.mode === 'demo') return;
    const missing = repo.listPositions(this.db.db, 200).filter((p) => !p.mintSymbol);
    if (missing.length === 0) return;
    const mints = [...new Set(missing.map((p) => p.mint))].slice(0, 5);
    await this.tokenMeta.resolve(mints, 3);
    let changed = false;
    for (const position of missing) {
      const symbol = this.tokenMeta.symbolFor(position.mint);
      if (!symbol || symbol === position.mintSymbol) continue;
      repo.updatePosition(this.db.db, position.positionId, { mintSymbol: symbol });
      changed = true;
    }
    if (changed) this.rebuildState();
  }

  /**
   * Re-price every open position's remaining tokens (token -> USDC quote) so
   * the dashboard's positions panel and unrealized PnL stay fresh. Failures
   * leave the previous mark in place; the builder ages stale marks out.
   */
  private async refreshMarks(): Promise<void> {
    if (this.config.mode === 'demo') return;
    for (const p of repo.openPositions(this.db.db)) {
      if (BigInt(p.remainingTokenBase) <= 0n) continue;
      try {
        const quote = await this.jupiter.quote({
          inputMint: p.mint,
          outputMint: USDC_MINT,
          amount: p.remainingTokenBase,
          slippageBps: 1000,
        });
        this.builder.setMark(p.positionId, BigInt(quote.outAmount), Date.now());
      } catch {
        // No mark this cycle; the positions panel shows "mark pending".
      }
    }
  }

  applySettings(patch: Record<string, unknown>): void {
    Object.assign(this.config.risk, patch);
    this.engine.setRisk(this.config.risk);
    this.lifecycle.setRisk(this.config.risk);
    repo.kvSet(this.db.db, 'risk.overrides', JSON.stringify(this.config.risk));
  }

  mountLiveExecutor(executor: LiveExecutor): void {
    this.liveExecutor = executor;
    (this.engine as unknown as { executor: PaperExecutor | LiveExecutor }).executor = executor;
  }

  unmountLiveExecutor(): void {
    this.liveExecutor = null;
    (this.engine as unknown as { executor: PaperExecutor | LiveExecutor }).executor = this.baseExecutor;
  }

  async closeAllPositions(reason: string): Promise<{ closed: number; unknown: number }> {
    const positions = repo.openPositions(this.db.db);
    let closed = 0;
    let unknown = 0;
    for (const p of positions) {
      const r = await this.engine.closePosition(p.positionId, reason);
      if (r === 'closed') closed++;
      else if (r === 'unknown') unknown++;
    }
    repo.controlEvent(this.db.db, 'close_all', `${closed} closed, ${unknown} unknown`, 'dashboard');
    return { closed, unknown };
  }

  startDemo(): void {
    this.demo?.stop();
    this.demo?.start();
  }

  /**
   * One discovery run through the fomoapi inlet (D3). `force` is the manual
   * operator path: it skips the demand/rate-limit gate, never the key check.
   */
  /**
   * The D5 demand trigger, called from the watch tick (and asserted directly by
   * runtime-cadence.test.ts): a thin bench asks for discovery, and the service
   * itself applies the rate limit and writes the audit line. When the roster and
   * the bench are full this is a no-op — zero external spend.
   */
  maybeDemandDiscovery(): void {
    // discoveryDecision holds the D5 rule: a free chair with nothing promotable
    // behind it, or a bench below BENCH_TARGET. The service then applies its own
    // rate limit and audits the decision, so a full roster + full bench really is
    // zero external spend.
    if (discoveryDecision(this.discovery.demand()).run) void this.discovery.syncIfNeeded();
  }

  async syncDiscoveryNow(force = false) {
    return this.discovery.syncDiscovery(force);
  }

  /**
   * Read the FOMO leaderboard through the logged-in browser session and merge
   * the entries into the candidate pool (source 'fomo-web'). Fail-closed: any
   * adapter error is audited and rethrown to the caller.
   */
  async fomoWebImportNow(): Promise<{ imported: number; warnings: string[] }> {
    if (!this.fomoWeb)
      throw new Error('FOMO web discovery is not configured (set FOMO_LEADERBOARD_URL in .env)');
    const result = await this.fomoWeb.fetchLatest();
    let imported = 0;
    for (const entry of result.entries) {
      const candidateId = repo.candidateIdForHandle(entry.handle);
      repo.upsertCandidate(this.db.db, {
        candidateId,
        handle: entry.handle,
        weeklyRank: entry.weeklyRank,
        displayedWeeklyPnlUsdMicro:
          entry.displayedPnlUsd !== null ? BigInt(Math.trunc(entry.displayedPnlUsd * 1e6)).toString() : null,
        profileUrl: entry.profileUrl,
        avatarUrl: entry.avatarUrl,
        enabled: entry.enabled,
        source: 'fomo-web',
        observedAt: entry.observedAt,
      });
      for (const addr of entry.solanaAddresses) {
        repo.upsertCandidateAddress(this.db.db, candidateId, {
          chain: 'solana',
          address: addr,
          verification: 'reported',
        });
      }
      repo.recordLeaderboardObservation(this.db.db, {
        handle: entry.handle,
        weeklyRank: entry.weeklyRank,
        displayedPnlUsdMicro:
          entry.displayedPnlUsd !== null ? BigInt(Math.trunc(entry.displayedPnlUsd * 1e6)).toString() : null,
        source: 'fomo-web',
        observedAt: entry.observedAt,
        importId: result.importId,
      });
      imported++;
    }
    repo.audit(this.db.db, 'fomo-web', `leaderboard fetch imported ${imported} candidates`, {
      importId: result.importId,
      warnings: result.warnings.slice(0, 10),
      personalProfileSync: this.fomoWeb?.lastSyncNote ?? undefined,
    });
    this.rebuildState();
    return { imported, warnings: result.warnings };
  }

  /** Open the visible FOMO browser so the operator can log in (one-time). */
  async fomoWebOpenLogin(): Promise<void> {
    if (!this.fomoWeb)
      throw new Error('FOMO web discovery is not configured (set FOMO_LEADERBOARD_URL in .env)');
    await this.fomoWeb.openForManualLogin();
    repo.audit(this.db.db, 'fomo-web', 'manual login window opened', {});
  }

  /**
   * Setup helper: dump the page currently shown in the FOMO browser to
   * DATA_DIR/fomo-debug/ so the leaderboard selectors can be configured
   * against the real DOM. Page HTML only — never contains credentials.
   */
  async fomoWebDebugCapture(): Promise<{ url: string; title: string; file: string }> {
    if (!this.fomoWeb)
      throw new Error('FOMO web discovery is not configured (set FOMO_LEADERBOARD_URL in .env)');
    const capture = await this.fomoWeb.debugCapture();
    const dir = join(this.config.env.DATA_DIR, 'fomo-debug');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `page-${Date.now()}.html`);
    writeFileSync(file, capture.html);
    repo.audit(this.db.db, 'fomo-web', 'debug page captured for selector setup', {
      url: capture.url,
      title: capture.title,
      file,
    });
    return { url: capture.url, title: capture.title, file };
  }

  heliusRpcUrl(): string {
    return `https://mainnet.helius-rpc.com/?api-key=${this.config.env.HELIUS_API_KEY}`;
  }

  /**
   * Resolve wallet addresses for candidates that don't have one yet, by asking
   * the Dawn bot about each fomo handle through the operator's Telegram Web
   * session. Read-only on Dawn: text messages only, never a copytrade task.
   * Fail-closed: a missing Telegram session aborts the whole run with an audit
   * entry (no partial retries hammering the bot).
   */
  async dawnLookupNow(limit = this.config.env.DAWN_MAX_LOOKUPS_PER_RUN): Promise<{
    resolved: number;
    failed: number;
    warnings: string[];
  }> {
    if (!this.dawnLookup) throw new Error('Dawn lookup is not configured (set DAWN_BOT_USERNAME in .env)');
    // Boot run, 6h timer and the Ops action share no common lock; serialize here
    // so two triggers can never double-message the Telegram bot.
    if (this.dawnRunBusy) {
      repo.audit(this.db.db, 'dawn-lookup', 'lookup skipped: another run already in progress', {});
      return { resolved: 0, failed: 0, warnings: ['another lookup run is already in progress'] };
    }
    this.dawnRunBusy = true;
    try {
      return await this.dawnLookupNowInner(this.dawnLookup, limit);
    } finally {
      this.dawnRunBusy = false;
    }
  }

  private async dawnLookupNowInner(
    provider: NonNullable<Runtime['dawnLookup']>,
    limit: number,
  ): Promise<{
    resolved: number;
    failed: number;
    warnings: string[];
  }> {
    // Two queues: discovery first (no wallet yet), then freshness (stats stale).
    // selectDawnTargets sorts each queue — freshest board rows get wallets
    // first, and the stale-stats tail refreshes oldest-first so no candidate's
    // PnL marks can freeze out past the cap.
    const nowIso = new Date().toISOString();
    const staleCutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const candidates = repo.listCandidates(this.db.db).filter((c) => c.enabled);
    const wallets = new Set(
      repo
        .listCandidateAddresses(this.db.db)
        .filter((a) => a.chain === 'solana')
        .map((a) => a.candidateId),
    );
    const targets = selectDawnTargets(candidates, wallets, staleCutoff, limit).filter(
      (c) => !this.dawnNoCardRecently(c.candidateId),
    );
    if (targets.length === 0) {
      repo.audit(
        this.db.db,
        'dawn-lookup',
        'lookup run: no targets (every enabled candidate has a wallet and fresh stats)',
        {},
      );
      return { resolved: 0, failed: 0, warnings: [] };
    }
    repo.audit(
      this.db.db,
      'dawn-lookup',
      `lookup run starting: ${targets.length} target(s), oldest stats first: ${targets
        .slice(0, 3)
        .map((t) => t.handle)
        .join(', ')}`,
      {},
    );

    const state = await provider.sessionState();
    if (state === 'needs-login') {
      repo.audit(this.db.db, 'dawn-lookup', 'Telegram session needs login; QR login window opened', {});
      await this.dawnOpenLogin();
      throw new DawnNeedsLoginError();
    }

    let resolved = 0;
    let failed = 0;
    const warnings: string[] = [];
    for (const cand of targets) {
      try {
        const info = await provider.lookupHandle(
          cand.handle,
          (cand as { profileUrl?: string | null }).profileUrl ?? undefined,
        );
        if (info.solanaAddress) {
          repo.upsertCandidateAddress(this.db.db, cand.candidateId, {
            chain: 'solana',
            address: info.solanaAddress,
            verification: 'reported',
          });
          resolved++;
        } else {
          failed++;
          warnings.push(cand.handle + ': no Solana address in Dawn reply');
        }
        // Store the day-trader stats columns (win rate, realized) on every reply.
        repo.updateCandidateStats(this.db.db, cand.candidateId, {
          winRatePct: info.winRatePct,
          realizedOnchainUsd: info.realizedOnchainUsd,
          checkedAt: nowIso,
        });
        if (info.pnlOnFomoUsd !== null || info.realizedOnchainUsd !== null || info.winRatePct !== null) {
          repo.audit(this.db.db, 'dawn-lookup', cand.handle + ': Dawn stats observed', {
            pnlOnFomoUsd: info.pnlOnFomoUsd,
            realizedOnchainUsd: info.realizedOnchainUsd,
            winRatePct: info.winRatePct,
          });
        }
      } catch (e) {
        if (e instanceof DawnNeedsLoginError) {
          warnings.push(cand.handle + ': session expired mid-run');
          break;
        }
        if (e instanceof DawnNoCardError) {
          // Silent bot, healthy session: note it durably and move on to the
          // next target. After two such runs the handle is parked for 6h so a
          // dead profile cannot monopolise every lookup cycle.
          this.noteDawnNoCard(cand.candidateId, cand.handle);
          failed++;
          warnings.push(cand.handle + ': no card (recorded, moving on)');
          continue;
        }
        failed++;
        warnings.push(cand.handle + ': ' + (e as Error).message);
      }
    }
    repo.audit(
      this.db.db,
      'dawn-lookup',
      'resolved ' + resolved + ' address(es), ' + failed + ' unresolved',
      {
        warnings: warnings.slice(0, 10),
      },
    );
    if (resolved > 0) {
      this.rebuildState();
    }
    return { resolved, failed, warnings };
  }

  /**
   * Record a silent-Dawn result for one candidate. Two consecutive no-card
   * runs park the handle for six hours: the card is absent on Dawn's side, so
   * retrying sooner only burns run slots that other names need.
   */
  private noteDawnNoCard(candidateId: string, handle: string): void {
    const key = `dawn.noCard:${candidateId}`;
    const prev = repo.kvGet(this.db.db, key);
    const parsed = prev ? (JSON.parse(prev) as { count: number; at: string }) : { count: 0, at: '' };
    const count = parsed.count + 1;
    repo.kvSet(this.db.db, key, JSON.stringify({ count, at: new Date().toISOString() }));
    repo.recordCandidateRejection(this.db.db, {
      recommendationId: null,
      candidateId,
      reason: 'DAWN_NO_CARD',
      detail: `Dawn returned no trader card for @${handle} while the Telegram session was healthy (${count} consecutive run(s))`,
    });
    repo.audit(this.db.db, 'dawn-lookup', `${handle}: no card from Dawn; noted, continuing`, {
      candidateId,
      consecutive: count,
    });
  }

  /** True when this candidate is parked after repeated silent-Dawn runs. */
  private dawnNoCardRecently(candidateId: string): boolean {
    // Shared escalating rule (see services/dawn-park.ts): 2 silences → 6h,
    // 3+ → a week. The CLI uses the same helper so neither path re-attempts a
    // handle the other already parked.
    return isDawnParked(this.db.db, candidateId);
  }

  /**
   * Refresh on-chain activity for enabled candidates that already have a
   * wallet. Primary source: the free public Solana RPC (direction-aware:
   * swaps24h/lastSwapAt + buys24h/sells24h/lastBuyAt); Helius is the fallback.
   * These are the on-chain numbers the watch list and the admission screen read,
   * so the stored reading and the gate agree. Read-only on-chain; a total source failure
   * marks the candidate's check 'failed' and preserves the previous columns.
   */
  async activityRefreshNow(
    limit = this.config.env.ACTIVITY_MAX_PER_RUN,
  ): Promise<{ checked: number; verified: number; failed: number }> {
    const nowIso = new Date().toISOString();
    const wallets = new Map<string, string>();
    for (const a of repo.listCandidateAddresses(this.db.db)) {
      if (a.chain === 'solana' && !wallets.has(a.candidateId)) wallets.set(a.candidateId, a.address);
    }
    const targets = repo
      .listCandidates(this.db.db)
      .filter((c) => c.enabled && wallets.has(c.candidateId))
      .sort((x, y) => {
        const ax = x.activityCheckedAt ?? '';
        const ay = y.activityCheckedAt ?? '';
        return ax < ay ? -1 : ax > ay ? 1 : 0; // null/oldest first
      })
      .slice(0, limit);
    if (targets.length === 0) return { checked: 0, verified: 0, failed: 0 };

    let checked = 0;
    let verified = 0;
    let failed = 0;
    for (const cand of targets) {
      const address = wallets.get(cand.candidateId);
      if (!address) continue;
      try {
        const reading = await checkWalletActivity(this.publicSolana, this.priceProvider, address, {
          lookbackHours: 24,
        });
        repo.updateCandidateActivity(this.db.db, cand.candidateId, {
          swaps24h: reading.copyableTrades24h,
          lastSwapAt: reading.lastTradeAt,
          lastBuyAt: reading.lastEntryAt,
          buys24h: reading.entries24h,
          sells24h: reading.exits24h,
          status: 'ok',
          checkedAt: nowIso,
        });
        checked++;
        const lastTradeAgeHours =
          reading.lastTradeAt === null ? null : (Date.now() - Date.parse(reading.lastTradeAt)) / 3_600_000;
        const passesGate =
          lastTradeAgeHours !== null &&
          lastTradeAgeHours <= this.config.risk.MAX_LEADER_STALL_HOURS &&
          reading.copyableTrades24h >= this.config.risk.MIN_LEADER_SWAPS_24H;
        if (passesGate) {
          repo.upgradeCandidateAddressVerification(this.db.db, cand.candidateId, 'solana', address);
          verified++;
        }
      } catch (e) {
        failed++;
        repo.markCandidateActivityFailed(this.db.db, cand.candidateId, nowIso);
        repo.audit(this.db.db, 'activity', cand.handle + ': ' + (e as Error).message, {});
      }
      await sleep(350);
    }
    repo.audit(
      this.db.db,
      'activity',
      'activity refresh: ' + checked + ' checked, ' + verified + ' verified, ' + failed + ' failed',
      {},
    );
    if (checked > 0) {
      this.rebuildState();
    }
    return { checked, verified, failed };
  }

  /** Open the visible Telegram Web window so the operator can scan the QR (one-time). */
  async dawnOpenLogin(): Promise<void> {
    if (!this.dawnLookup) throw new Error('Dawn lookup is not configured (set DAWN_BOT_USERNAME in .env)');
    await this.dawnLookup.openForManualLogin();
    repo.audit(this.db.db, 'dawn-lookup', 'manual Telegram QR login window opened', {});
  }

  /**
   * Update provider credentials from the SETTINGS keys form: applies them to
   * the running providers immediately AND persists to <repo>/.env so restarts
   * keep them. Key values are never returned to any client and never logged.
   * The .env path can be overridden for tests (ZCODE_ENV_FILE).
   */
  applyProviderKeys(input: { heliusApiKey?: string; jupiterApiKey?: string; jupiterBaseUrl?: string }): {
    helius: boolean;
    jupiterKey: boolean;
  } {
    const updates: Array<[string, string]> = [];
    if (input.heliusApiKey) updates.push(['HELIUS_API_KEY', input.heliusApiKey]);
    if (input.jupiterApiKey) updates.push(['JUPITER_API_KEY', input.jupiterApiKey]);
    if (input.jupiterBaseUrl) updates.push(['JUPITER_BASE_URL', input.jupiterBaseUrl]);

    if (updates.length > 0) {
      const envFile = process.env.ZCODE_ENV_FILE ?? join(REPO_ROOT, '.env');
      let text = existsSync(envFile) ? readFileSync(envFile, 'utf8') : '# created by Copydesk\n';
      for (const [key, value] of updates) {
        const line = `${key}=${value}`;
        if (new RegExp(`^${key}=.*$`, 'm').test(text))
          text = text.replace(new RegExp(`^${key}=.*$`, 'm'), line);
        else text = `${text.replace(/\n*$/, '\n')}${line}\n`;
      }
      writeFileSync(envFile, text);
    }

    if (input.heliusApiKey) {
      this.helius.setApiKey(input.heliusApiKey);
      this.config.env.HELIUS_API_KEY = input.heliusApiKey;
    }
    if (input.jupiterApiKey || input.jupiterBaseUrl) {
      const base = input.jupiterBaseUrl ?? this.config.env.JUPITER_BASE_URL;
      const key = input.jupiterApiKey ?? this.config.env.JUPITER_API_KEY;
      this.jupiter.setCredentials(base, key);
      this.config.env.JUPITER_BASE_URL = base;
      this.config.env.JUPITER_API_KEY = key;
      // The paper executor and pricer hold the same Jupiter instance.
      if (this.priceProvider instanceof JupiterPriceProvider) this.priceProvider.setJupiter(this.jupiter);
      this.baseExecutor.setJupiter(this.jupiter);
    }

    repo.audit(this.db.db, 'settings', 'provider keys updated', {
      helius: Boolean(input.heliusApiKey),
      jupiterKey: Boolean(input.jupiterApiKey),
      jupiterBaseUrl: Boolean(input.jupiterBaseUrl),
    });
    return {
      helius: this.helius.configured,
      jupiterKey: this.config.env.JUPITER_API_KEY.length > 0,
    };
  }

  // ---- setup + submit tokens -------------------------------------------------

  /** One-time first-run token; printed to console and written to data/setup-token.txt. */
  ensureSetupToken(): SetupToken {
    if (repo.countUsers(this.db.db) > 0) {
      throw new Error('setup already completed');
    }
    if (!this.setupToken || this.setupToken.expiresAt < Date.now()) {
      this.setupToken = { value: randomBytes(24).toString('base64url'), expiresAt: Date.now() + 30 * 60_000 };
    }
    const file = join(this.config.env.DATA_DIR, 'setup-token.txt');
    mkdirSync(this.config.env.DATA_DIR, { recursive: true });
    writeFileSync(file, `setup token (valid 30 minutes): ${this.setupToken.value}\n`, { mode: 0o600 });
    return this.setupToken;
  }

  consumeSetupToken(value: string | undefined): boolean {
    if (!this.setupToken || !value) return false;
    if (this.setupToken.expiresAt < Date.now()) return false;
    if (this.setupToken.value !== value) return false;
    this.setupToken = null; // one-time
    return true;
  }

  /**
   * TEST-ONLY: expose the in-memory setup token via /api/bootstrap when
   * NODE_ENV=test. The e2e runner's test worker cannot reliably read files
   * written by the spawned server process, so tests fetch the token from the
   * API. Production (any other NODE_ENV) always returns null.
   */
  currentSetupTokenForTests(): string | null {
    if (process.env.NODE_ENV !== 'test') return null;
    if (!this.setupToken || this.setupToken.expiresAt < Date.now()) return null;
    return this.setupToken.value;
  }
}

export { repoRoot };
