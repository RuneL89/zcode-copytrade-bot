import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { join } from 'node:path';
import type { AppDatabase } from '@zcode-bot/db';
import * as repo from '@zcode-bot/db/repo.js';
import { settingsPatchSchema, riskConfigSchema, LIVE_ACK_STRING } from '@zcode-bot/config';
import {
  DAILY_HARD_CAP,
  FREE_PLAN_CREDITS,
  MONTH_AMBER,
  MONTH_EXITS_ONLY,
  MONTH_RED,
  MONTH_ROSTER_ONLY,
  PATH_BUDGETS,
  lastCompletedWeek,
  riskPatchDirection,
  weekRange,
} from '@zcode-bot/core';
import { parseManualCsv, parseManualJson } from '@zcode-bot/providers';
import {
  applyCsrfCookie,
  applySessionCookie,
  clearSessionCookie,
  controlLimiter,
  csrfOk,
  hashPassword,
  issueCsrfToken,
  loginLimiter,
  redact,
  requireAuth,
  requireCsrf,
  SessionManager,
  verifyPassword,
  type AppEnv,
} from '../auth.js';
import type { Runtime } from '../runtime.js';
import { PAPER_ASSUMPTIONS } from '../services/executors.js';
import { loadWalletSecret, walletPublicKey } from '../wallet.js';
import { rememberWalletPassphrase } from '../wallet-unlock.js';
import { LiveExecutor } from '../services/executors.js';
import { adjustExit, decideHire, overruleSeat } from '../services/agentHooks.js';
import { buildWeeklyReview, renderWeeklyReviewMarkdown, weeklyReviewJson } from '../services/weeklyReview.js';

export function buildApp(rt: Runtime): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const sessions = new SessionManager(rt.config.env.SESSION_SECRET);
  const db: AppDatabase = rt.db.db;
  const bookMode = rt.config.mode === 'live' ? 'live' : 'paper';

  // ---- local agent hooks (no session; a separate token; no order or arm routes)
  const agentDenied = (c: Context<AppEnv>) => {
    const expected = rt.config.env.AGENT_API_TOKEN;
    if (!expected) return c.json({ error: 'agent api disabled' }, 404);
    if (c.req.header('authorization') !== `Bearer ${expected}`) return c.json({ error: 'unauthorized' }, 401);
    if (rt.config.mode === 'live' && !rt.config.env.AGENT_LIVE_CONTROL) {
      return c.json(
        {
          error: 'agent trading control is disabled while MODE=live (set AGENT_LIVE_CONTROL=true to opt in)',
        },
        403,
      );
    }
    return null;
  };

  app.post('/api/agent/hire-decisions', async (c) => {
    const denied = agentDenied(c);
    if (denied) return denied;
    const body = await c.req.json().catch(() => null);
    const result = await decideHire(
      db,
      rt.config.risk,
      rt.lifecycle,
      (body ?? {}) as Record<string, unknown>,
      rt.config.mode === 'live' ? 'live' : 'paper',
    );
    return c.json(result.body, result.status as 200);
  });

  app.post('/api/agent/overrule', async (c) => {
    const denied = agentDenied(c);
    if (denied) return denied;
    const body = await c.req.json().catch(() => null);
    const result = await overruleSeat(db, rt.lifecycle, (body ?? {}) as Record<string, unknown>);
    return c.json(result.body, result.status as 200);
  });

  app.post('/api/agent/exit-adjustments', async (c) => {
    const denied = agentDenied(c);
    if (denied) return denied;
    const body = await c.req.json().catch(() => null);
    const result = await adjustExit(db, rt.config.risk, rt.engine, (body ?? {}) as Record<string, unknown>);
    return c.json(result.body, result.status as 200);
  });

  // ---- public bootstrap -----------------------------------------------------

  app.get('/api/bootstrap', (c) => {
    const needsSetup = repo.countUsers(db) === 0;
    const state = rt.store.get();
    return c.json({
      needsSetup,
      mode: rt.config.mode,
      armed: rt.control.flags.armed && rt.liveExecutorMounted(),
      fictional: rt.config.mode === 'demo',
      appState: state?.appState ?? 'PAUSED_NO_TRADER',
      setupTokenFileHint: needsSetup ? 'the one-time setup token is printed on the server console' : null,
      // NODE_ENV=test only — see Runtime.currentSetupTokenForTests().
      testSetupToken: rt.currentSetupTokenForTests(),
    });
  });

  // ---- first-run setup + login ----------------------------------------------
  app.post('/api/setup', async (c) => {
    if (repo.countUsers(db) > 0) return c.json({ error: 'setup already completed' }, 409);
    const rl = loginLimiter.check('setup');
    if (!rl.allowed) return c.json({ error: `rate limited; retry in ${rl.retryAfterSeconds}s` }, 429);
    const body = await c.req.json().catch(() => null);
    const { setupToken, username, password } = (body ?? {}) as Record<string, string>;
    if (!rt.consumeSetupToken(setupToken)) {
      return c.json({ error: 'invalid or expired setup token (see server console)' }, 403);
    }
    if (!username || !/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) {
      return c.json({ error: 'username must be 3-32 chars [a-zA-Z0-9_.-]' }, 400);
    }
    if (!password || password.length < 10) {
      return c.json({ error: 'password must be at least 10 characters' }, 400);
    }
    repo.createUser(db, username, hashPassword(password));
    repo.audit(db, 'auth', 'dashboard user created via setup wizard', { username });
    const session = sessions.issue(username);
    applySessionCookie(c, session.token, session.expiresAt);
    applyCsrfCookie(c, issueCsrfToken());
    return c.json({ ok: true, username });
  });

  app.post('/api/login', async (c) => {
    const ip = c.req.header('x-forwarded-for') ?? 'local';
    const rl = loginLimiter.check(ip);
    if (!rl.allowed) return c.json({ error: `rate limited; retry in ${rl.retryAfterSeconds}s` }, 429);
    const body = await c.req.json().catch(() => null);
    const { username, password } = (body ?? {}) as Record<string, string>;
    const user = username ? repo.getUser(db, username) : undefined;
    if (!user || !password || !verifyPassword(password, user.passwordHash)) {
      repo.audit(db, 'auth', 'failed login attempt', { username: username ?? null });
      return c.json({ error: 'invalid credentials' }, 401);
    }
    const session = sessions.issue(user.username);
    applySessionCookie(c, session.token, session.expiresAt);
    applyCsrfCookie(c, issueCsrfToken());
    repo.audit(db, 'auth', 'login ok', { username: user.username });
    return c.json({ ok: true, username: user.username });
  });

  app.post('/api/logout', (c) => {
    clearSessionCookie(c);
    return c.json({ ok: true });
  });

  app.get('/api/me', requireAuth(sessions), (c) => c.json({ username: c.get('username') }));

  app.get('/api/csrf', requireAuth(sessions), (c) => {
    const token = issueCsrfToken();
    applyCsrfCookie(c, token);
    return c.json({ token });
  });

  // ---- state + SSE -----------------------------------------------------------
  app.get('/api/state', requireAuth(sessions), (c) => {
    const state = rt.store.get() ?? rt.rebuildState();
    return c.json(state);
  });

  app.get('/api/stream', requireAuth(sessions), (c) => {
    return streamSSE(c, async (stream) => {
      // Poll the authoritative store: lastSentVersion must be captured BEFORE
      // any publish (updating it inside the subscribe callback would race and
      // suppress every subsequent state frame).
      let lastSentVersion = rt.store.get()?.version ?? -1;
      const send = async () => {
        const state = rt.store.get();
        if (state && state.version !== lastSentVersion) {
          lastSentVersion = state.version;
          await stream.writeSSE({ event: 'state', data: JSON.stringify(state) });
        } else {
          await stream.writeSSE({
            event: 'heartbeat',
            data: JSON.stringify({ t: new Date().toISOString() }),
          });
        }
      };
      // Initial resync from authoritative state (never replayed fabrications).
      const initial = rt.store.get() ?? rt.rebuildState();
      lastSentVersion = initial.version;
      await stream.writeSSE({ event: 'state', data: JSON.stringify(initial) });
      const interval = setInterval(() => void send().catch(() => undefined), 1000);
      stream.onAbort(() => {
        clearInterval(interval);
      });
      while (!stream.aborted) {
        await stream.sleep(1000);
      }
    });
  });

  // ---- read-only data ----------------------------------------------------------
  app.get('/api/equity-series', requireAuth(sessions), (c) =>
    c.json({ series: (rt.store.get() ?? rt.rebuildState()).equity.series }),
  );
  app.get('/api/trader/history', requireAuth(sessions), (c) =>
    c.json({ activations: repo.listActivations(db, 100, bookMode) }),
  );
  app.get('/api/positions', requireAuth(sessions), (c) =>
    c.json({ positions: repo.listPositions(db, 200, bookMode) }),
  );
  app.get('/api/closes', requireAuth(sessions), (c) => c.json({ lots: repo.listPnlLots(db, 500, bookMode) }));
  app.get('/api/candidates', requireAuth(sessions), (c) =>
    c.json({
      candidates: repo.listCandidates(db),
      addresses: repo.listCandidateAddresses(db),
    }),
  );
  app.get('/api/health/providers', requireAuth(sessions), (c) =>
    c.json({ health: repo.latestProviderHealth(db) }),
  );
  app.get('/api/audit', requireAuth(sessions), (c) => c.json({ events: repo.listAudit(db, 300) }));
  app.get('/api/control-events', requireAuth(sessions), (c) =>
    c.json({ events: repo.listControlEvents(db, 100) }),
  );
  app.get('/api/rejections', requireAuth(sessions), (c) => {
    // Risk rejections are the entry gates; candidate rejections are the hire /
    // promotion gates. Both are read-only audit evidence for the funnel's
    // dropouts lane (handles resolved here so the UI never guesses).
    const candidateRejections = repo.listCandidateRejections(db, 100).map((row) => ({
      ...row,
      handle: repo.getCandidate(db, row.candidateId)?.handle ?? row.candidateId,
    }));
    return c.json({
      rejections: repo.listRiskRejections(db, 300, bookMode),
      candidateRejections,
    });
  });
  app.get('/api/reconciliation', requireAuth(sessions), (c) =>
    c.json({ cases: repo.openReconciliationCases(db) }),
  );
  app.get('/api/observed-events', requireAuth(sessions), (c) =>
    c.json({ events: repo.listObservedEvents(db, undefined, 200, bookMode) }),
  );

  // ---- settings -----------------------------------------------------------------
  app.get('/api/settings', requireAuth(sessions), async (c) => {
    const readiness = await rt.readiness();
    let publicKey: string | null = null;
    try {
      publicKey = walletPublicKey(rt.config.env.DATA_DIR, rt.config.env.WALLET_FILE);
    } catch {
      publicKey = null;
    }
    return c.json({
      mode: rt.config.mode,
      armed: rt.control.flags.armed && rt.config.mode === 'live' && rt.liveExecutorMounted(),
      risk: rt.config.risk,
      paperAssumptions: PAPER_ASSUMPTIONS,
      providers: {
        heliusConfigured: rt.helius.configured,
        jupiter: {
          baseUrl: rt.config.env.JUPITER_BASE_URL,
          keyConfigured: rt.config.env.JUPITER_API_KEY.length > 0,
        },
        telegramConfigured: Boolean(rt.config.env.TELEGRAM_BOT_TOKEN && rt.config.env.TELEGRAM_CHAT_ID),
        fomoWebConfigured: Boolean(process.env.FOMO_LEADERBOARD_URL),
        // Never the key itself — presence only (D3 inlet).
        fomoApiConfigured: Boolean(rt.config.env.FOMOAPI_KEY?.trim()),
        fomoApiBaseUrl: rt.config.env.FOMOAPI_BASE_URL,
      },
      wallet: {
        exists: Boolean(publicKey),
        publicKey,
      },
      readiness,
      live: {
        executorMounted: rt.liveExecutorMounted(),
      },
      control: rt.control.flags,
      hiring: {
        mode: rt.config.env.HIRE_APPROVAL,
        hiresToday: repo
          .listActivations(db, 500, bookMode)
          .filter((a) => a.startedAt >= new Date(new Date().toISOString().slice(0, 10)).toISOString()).length,
      },
      liveAckString: LIVE_ACK_STRING,
    });
  });

  app.get('/api/credits', requireAuth(sessions), (c) => {
    const snap = rt.creditGovernor.snapshot(Date.now());
    const raw = repo.kvGet(db, 'helius.usage');
    let reported: unknown = null;
    if (raw) {
      try {
        reported = JSON.parse(raw);
      } catch {
        reported = null;
      }
    }
    const reportedRecord =
      reported && typeof reported === 'object' ? (reported as { admin?: string; detail?: string }) : null;
    const admin = !rt.config.env.HELIUS_PROJECT_ID ? 'unset' : (reportedRecord?.admin ?? 'unknown');
    return c.json({
      dayTotal: snap.dayTotal,
      month: snap.month,
      level: snap.level,
      byPath: snap.byPath,
      hardCap: DAILY_HARD_CAP,
      monthCeiling: MONTH_ROSTER_ONLY,
      freePlan: FREE_PLAN_CREDITS,
      paths: PATH_BUDGETS,
      monthCaps: {
        amber: MONTH_AMBER,
        red: MONTH_RED,
        rosterOnly: MONTH_ROSTER_ONLY,
        exitsOnly: MONTH_EXITS_ONLY,
      },
      admin,
      adminDetail:
        admin === 'ok'
          ? null
          : (reportedRecord?.detail ??
            (admin === 'unset'
              ? 'HELIUS_PROJECT_ID is not set. The figure on this screen is the in-app meter.'
              : 'Helius Admin usage is unavailable. The figure on this screen is the in-app meter.')),
      reported,
    });
  });

  // Read-only weekly performance review. The generator only SELECTs from the
  // DB; the JSON and markdown are returned for the dashboard view.
  app.get('/api/reports/weekly', requireAuth(sessions), (c) => {
    const timeZone = 'Europe/Helsinki';
    const now = new Date();
    const weekParam = c.req.query('week');
    let week: ReturnType<typeof lastCompletedWeek>;
    try {
      week = weekParam ? weekRange(weekParam, timeZone) : lastCompletedWeek(now, timeZone);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
    try {
      const report = buildWeeklyReview({
        sqlite: rt.db.sqlite,
        mode: rt.config.mode,
        dbPath: join(rt.config.env.DATA_DIR, 'zcode-bot.db'),
        week,
        now,
        timeZone,
      });
      return c.json({
        week: week.label,
        report: weeklyReviewJson(report),
        markdown: renderWeeklyReviewMarkdown(report),
      });
    } catch (e) {
      return c.json({ error: `weekly review failed: ${(e as Error).message}` }, 500);
    }
  });

  app.patch('/api/settings', requireAuth(sessions), requireCsrf, async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const pin = typeof body?.pin === 'string' ? body.pin : '';
    const patchBody = { ...(body ?? {}) };
    delete patchBody.pin;
    const parsed = settingsPatchSchema.safeParse(patchBody);
    if (!parsed.success) {
      return c.json(
        {
          error: 'invalid settings patch',
          issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
        },
        400,
      );
    }
    // The patch may be individually valid yet leave the merged config
    // inconsistent (e.g. MAX_PER_BUY_PCT raised above MAX_OPEN_PER_TRADER_PCT):
    // validate the merged result so an inverted pair is refused here, not
    // discovered at order time.
    const mergedRisk = riskConfigSchema.safeParse({ ...rt.config.risk, ...parsed.data });
    if (!mergedRisk.success) {
      return c.json(
        {
          error: 'invalid settings patch',
          issues: mergedRisk.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
        },
        400,
      );
    }
    const direction = riskPatchDirection(
      rt.config.risk as unknown as Record<string, unknown>,
      parsed.data as unknown as Record<string, unknown>,
    );
    if (direction === 'increase') {
      const expected = rt.config.env.RISK_PIN;
      if (!expected || pin !== expected) {
        return c.json({ error: 'raising risk needs the PIN' }, 403);
      }
    }
    rt.applySettings(parsed.data);
    repo.audit(db, 'settings', 'risk settings updated', redact(parsed.data));
    // Publish immediately: the trade screen's counters (time-exit window,
    // idle-fire countdown) read the store, and the SSE stream only pushes on a
    // version bump — without this the old values linger until the next
    // unrelated rebuild.
    rt.rebuildState();
    return c.json({ ok: true, risk: rt.config.risk });
  });

  // ---- leaderboard import ---------------------------------------------------------
  app.post('/api/import/leaderboard', requireAuth(sessions), requireCsrf, async (c) => {
    const body = await c.req.json().catch(() => null);
    const { format, content } = (body ?? {}) as { format?: string; content?: string };
    if (!content || (format !== 'json' && format !== 'csv')) {
      return c.json({ error: 'provide {format: "json"|"csv", content: "<data>"}' }, 400);
    }
    const result = format === 'csv' ? parseManualCsv(content) : parseManualJson(content);
    for (const entry of result.entries) {
      const candidateId = repo.candidateIdForHandle(entry.handle);
      repo.upsertCandidate(db, {
        candidateId,
        handle: entry.handle,
        weeklyRank: entry.weeklyRank,
        displayedWeeklyPnlUsdMicro:
          entry.displayedPnlUsd !== null ? BigInt(Math.trunc(entry.displayedPnlUsd * 1e6)).toString() : null,
        profileUrl: entry.profileUrl,
        avatarUrl: entry.avatarUrl,
        enabled: entry.enabled,
        source: `manual-${format}`,
        observedAt: entry.observedAt,
      });
      for (const addr of entry.solanaAddresses) {
        repo.upsertCandidateAddress(db, candidateId, {
          chain: 'solana',
          address: addr,
          verification: 'reported',
        });
      }
      repo.recordLeaderboardObservation(db, {
        handle: entry.handle,
        weeklyRank: entry.weeklyRank,
        displayedPnlUsdMicro:
          entry.displayedPnlUsd !== null ? BigInt(Math.trunc(entry.displayedPnlUsd * 1e6)).toString() : null,
        source: `manual-${format}`,
        observedAt: entry.observedAt,
        importId: result.importId,
      });
    }
    repo.audit(db, 'import', `manual leaderboard import (${format})`, {
      importId: result.importId,
      entries: result.entries.length,
      warnings: result.warnings,
      skipped: result.skipped,
    });
    return c.json({
      ok: true,
      importId: result.importId,
      entries: result.entries.length,
      warnings: result.warnings,
      skipped: result.skipped,
    });
  });

  // ---- candidate + trader controls --------------------------------------------------
  app.post('/api/activate', requireAuth(sessions), requireCsrf, async (c) => {
    const ip = c.req.header('x-forwarded-for') ?? 'local';
    const rl = controlLimiter.check(ip + 'activate');
    if (!rl.allowed) return c.json({ error: `rate limited; retry in ${rl.retryAfterSeconds}s` }, 429);
    const body = await c.req.json().catch(() => null);
    const { candidateId, confirm } = (body ?? {}) as { candidateId?: string; confirm?: string };
    if (!candidateId) return c.json({ error: 'candidateId required' }, 400);
    if (rt.config.mode === 'live' && confirm !== 'ACTIVATE') {
      return c.json({ error: 'live activation requires {"confirm":"ACTIVATE"}' }, 400);
    }
    // The roster is addressed per candidate: a candidate already holding a chair
    // is refused here rather than silently double-booked (plan 05).
    if (repo.listActiveActivations(db, bookMode).some((a) => a.candidateId === candidateId)) {
      return c.json({ error: 'that candidate already holds a roster chair' }, 409);
    }
    const result = await rt.lifecycle.activate(candidateId, 'manual');
    rt.rebuildState();
    if (!result.ok) return c.json({ error: result.reason }, 400);
    return c.json({ ok: true, activationId: result.activationId });
  });

  app.post('/api/fire', requireAuth(sessions), requireCsrf, async (c) => {
    const ip = c.req.header('x-forwarded-for') ?? 'local';
    const rl = controlLimiter.check(ip + 'fire');
    if (!rl.allowed) return c.json({ error: `rate limited; retry in ${rl.retryAfterSeconds}s` }, 429);
    // The roster addresses ONE chair: an explicit activationId (or candidateId)
    // picks it; a bare call is only unambiguous with a single active leader.
    const body = (await c.req.json().catch(() => ({}))) as {
      activationId?: string;
      candidateId?: string;
      confirm?: string;
    };
    if (rt.config.mode === 'live' && body.confirm !== 'FIRE') {
      return c.json({ error: 'live firing requires {"confirm":"FIRE"}' }, 400);
    }
    const active = repo.listActiveActivations(db, bookMode);
    const target = body.activationId
      ? active.find((a) => a.activationId === body.activationId)
      : body.candidateId
        ? active.find((a) => a.candidateId === body.candidateId)
        : active.length === 1
          ? active[0]
          : undefined;
    if (!target) {
      return c.json(
        {
          error:
            active.length === 0
              ? 'no active trader'
              : 'several leaders are active; specify activationId or candidateId',
        },
        400,
      );
    }
    const outcome = await rt.lifecycle.fire(target.activationId, 'manual fire from dashboard');
    rt.rebuildState();
    return c.json({ ok: true, outcome });
  });

  // ---- watch list (D4) ----------------------------------------------------------------
  // Demo mode is fictional: a promotion would hire a real trader into the live
  // tables, so the actions are refused there (the panel's own promote button is
  // disabled by its blocked reason in that mode anyway).
  app.post('/api/watch/promote', requireAuth(sessions), requireCsrf, async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { candidateId?: string };
    if (!body.candidateId) return c.json({ error: 'candidateId required' }, 400);
    if (rt.config.mode === 'demo') {
      return c.json({ error: 'watch list actions are disabled in demo mode' }, 409);
    }
    const result = await rt.watch.promoteNow(body.candidateId);
    if (!result.ok) return c.json({ error: `cannot promote: ${result.reason}` }, 400);
    return c.json({ ok: true, outcome: result.reason });
  });

  app.post('/api/watch/archive', requireAuth(sessions), requireCsrf, async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { candidateId?: string };
    if (!body.candidateId) return c.json({ error: 'candidateId required' }, 400);
    if (rt.config.mode === 'demo') {
      return c.json({ error: 'watch list actions are disabled in demo mode' }, 409);
    }
    if (!repo.getWatchWallet(db, body.candidateId)) return c.json({ error: 'not on the watch list' }, 404);
    repo.setWatchStatus(db, body.candidateId, 'archived', 'archived from the dashboard');
    repo.audit(db, 'watch', 'watch archived from the dashboard', { candidateId: body.candidateId });
    rt.rebuildState();
    return c.json({ ok: true });
  });

  app.post('/api/watch/unarchive', requireAuth(sessions), requireCsrf, async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { candidateId?: string };
    if (!body.candidateId) return c.json({ error: 'candidateId required' }, 400);
    if (rt.config.mode === 'demo') {
      return c.json({ error: 'watch list actions are disabled in demo mode' }, 409);
    }
    if (!repo.getWatchWallet(db, body.candidateId)) return c.json({ error: 'not on the watch list' }, 404);
    // Back to watching: the promotion gate re-decides on the next tick.
    repo.setWatchStatus(db, body.candidateId, 'watching', 'unarchived from the dashboard');
    repo.audit(db, 'watch', 'watch unarchived from the dashboard', { candidateId: body.candidateId });
    rt.rebuildState();
    return c.json({ ok: true });
  });

  // ---- test-only seeding (NODE_ENV=test) ----------------------------------------------
  // The e2e suite needs watch-list rows to render, and the write path is a
  // network scan. This route exists only when NODE_ENV=test (same guard as
  // /api/bootstrap's testSetupToken) and only ever touches the caller's DB.
  if (process.env.NODE_ENV === 'test') {
    app.post('/api/test/seed-watch', async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as {
        handle?: string;
        closedTrades?: number;
        netPerTradeUsd?: number;
        lastBuyMinutesAgo?: number;
        openNotionalUsd?: number;
        openAgeHours?: number;
      };
      const handle = (body.handle ?? 'seeded_watch').trim();
      const candidateId = repo.candidateIdForHandle(handle);
      const now = Date.now();
      // Deterministic per call: a re-seed replaces the candidate's whole record
      // instead of piling new lots onto the old ones.
      repo.resetWatchRecord(db, candidateId);
      repo.upsertCandidate(db, {
        candidateId,
        handle,
        weeklyRank: null,
        displayedWeeklyPnlUsdMicro: null,
        profileUrl: null,
        avatarUrl: null,
        enabled: true,
        source: 'test-seed',
        observedAt: new Date(now).toISOString(),
      });
      repo.upsertCandidateAddress(db, candidateId, {
        chain: 'solana',
        address: `SeedWallet${handle}`,
        verification: 'reported',
      });
      repo.upsertWatchWallet(db, {
        candidateId,
        address: `SeedWallet${handle}`,
        status: 'watching',
        reason: 'test seed',
      });
      repo.insertWatchEvent(db, {
        candidateId,
        address: `SeedWallet${handle}`,
        signature: `seed-buy-${handle}`,
        side: 'buy',
        mint: 'SeedMint1111111111111111111111111111111111111',
        tokenAmountBase: '6000000',
        decimals: 6,
        usdMicro: '6000000',
        blockTime: Math.floor(now / 1000) - 60,
        observedAt: new Date(now - (body.lastBuyMinutesAgo ?? 5) * 60_000).toISOString(),
        source: 'test-seed',
      });
      for (let i = 0; i < (body.closedTrades ?? 0); i++) {
        const id = repo.openShadowTrade(db, {
          candidateId,
          mint: 'SeedMint1111111111111111111111111111111111111',
          openedAt: new Date(now - (i + 1) * 3_600_000).toISOString(),
          entryPriceUsdMicro: '1000000',
          notionalUsdMicro: '5000000',
        });
        repo.closeShadowTrade(db, id, {
          closedAt: new Date(now - (i + 1) * 3_600_000 + 60_000).toISOString(),
          exitReason: 'leader_sell',
          exitPriceUsdMicro: '1000000',
          pnlUsdMicro: String(Math.trunc((body.netPerTradeUsd ?? 0) * 1e6)),
        });
      }
      if (body.openNotionalUsd) {
        repo.openShadowTrade(db, {
          candidateId,
          mint: 'SeedMint1111111111111111111111111111111111111',
          openedAt: new Date(now - (body.openAgeHours ?? 1) * 3_600_000).toISOString(),
          entryPriceUsdMicro: '1000000',
          notionalUsdMicro: String(Math.trunc(body.openNotionalUsd * 1e6)),
        });
      }
      rt.rebuildState();
      return c.json({ ok: true, candidateId });
    });

    app.post('/api/test/seed-seat', async (c) => {
      // A filled chair with one open position, so the browser suite can expand a
      // seat without waiting for the replay or a real hire.
      const body = (await c.req.json().catch(() => ({}))) as {
        handle?: string;
        usd?: number;
        minutesAgo?: number;
      };
      const handle = (body.handle ?? 'seeded_seat').trim();
      const usd = Number.isFinite(body.usd) ? body.usd! : 10;
      const minutesAgo = Number.isFinite(body.minutesAgo) ? body.minutesAgo! : 30;
      const candidateId = repo.candidateIdForHandle(handle);
      const address = `SeedWallet${handle}`;
      // Idempotent per handle: a re-seed replaces the chair's positions and
      // activations instead of piling new ones onto the old run.
      rt.db.sqlite.prepare('DELETE FROM copied_positions WHERE candidate_id = ?').run(candidateId);
      rt.db.sqlite.prepare('DELETE FROM trader_activations WHERE candidate_id = ?').run(candidateId);
      repo.upsertCandidate(db, {
        candidateId,
        handle,
        weeklyRank: null,
        displayedWeeklyPnlUsdMicro: null,
        profileUrl: null,
        avatarUrl: null,
        enabled: true,
        source: 'test-seed',
        observedAt: new Date().toISOString(),
      });
      repo.upsertCandidateAddress(db, candidateId, { chain: 'solana', address, verification: 'reported' });
      repo.upsertWatchWallet(db, { candidateId, address, status: 'bench', reason: 'test seed' });
      const activationId = `act_seed_seat_${Date.now()}_${candidateId}`;
      repo.createActivation(db, {
        activationId,
        candidateId,
        state: 'ACTIVE',
        startedAt: new Date().toISOString(),
        endedAt: null,
        endReason: null,
        lossStreak: 0,
        firedReason: null,
        source: 'test',
      });
      const positionId = `pos_seed_${Date.now()}`;
      const perBuyUsd = usd / 2;
      repo.insertPosition(db, {
        positionId,
        activationId,
        candidateId,
        mint: 'SeedMint111111111111111111111111111111111111',
        mintSymbol: 'SEED',
        status: 'open',
        entryIntentId: null,
        inputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        inputUsdMicro: String(Math.trunc(usd * 1e6)),
        copiedTokenBase: '1000',
        remainingTokenBase: '1000',
        leaderTokenBase: null,
        realizedPnlUsdMicro: '0',
        feesUsdMicro: '1000',
        openedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
        closedAt: null,
        closeReason: null,
      });
      // Two copy buys behind the one position: the seat lists them individually.
      for (const n of [0, 1]) {
        const intentId = `intent_seed_${Date.now()}_${n}`;
        const at = new Date(Date.now() - (minutesAgo - n * 5) * 60_000).toISOString();
        repo.insertIntent(db, {
          intentId,
          kind: 'entry',
          mode: 'paper',
          activationId,
          candidateId,
          positionId,
          mint: 'SeedMint111111111111111111111111111111111111',
          inputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          inputAmountBase: String(Math.trunc(perBuyUsd * 1e6)),
          inputUsdMicro: String(Math.trunc(perBuyUsd * 1e6)),
          state: 'confirmed',
          idempotencyKey: `seed-${intentId}`,
          txSignature: `seed-sig-${n}`,
          createdAt: at,
          updatedAt: at,
        });
        repo.insertFill(db, {
          fillId: `fill_seed_${Date.now()}_${n}`,
          intentId,
          positionId,
          mode: 'paper',
          txSignature: `seed-sig-${n}`,
          inputAmountBase: String(Math.trunc(perBuyUsd * 1e6)),
          outputAmountBase: '500',
          feeEstimateUsdMicro: '0',
          commitment: 'confirmed',
          confirmedAt: at,
        });
      }
      rt.rebuildState();
      return c.json({ ok: true, candidateId, activationId, positionId });
    });

    app.post('/api/test/seed-firing', async (c) => {
      // The fired lane renders the last five firings. Seed one with a
      // realistically long legacy reason so the browser suite can prove the
      // row wraps inside its card instead of pushing the page sideways.
      const body = (await c.req.json().catch(() => ({}))) as {
        handle?: string;
        reason?: string;
        minutesAgo?: number;
      };
      const handle = (body.handle ?? 'seeded_fired').trim();
      const reason = (body.reason ?? 'RANK: LEFT THE BOARD').trim();
      const minutesAgo = Number.isFinite(body.minutesAgo) ? body.minutesAgo! : 30;
      const candidateId = repo.candidateIdForHandle(handle);
      repo.upsertCandidate(db, {
        candidateId,
        handle,
        weeklyRank: null,
        displayedWeeklyPnlUsdMicro: null,
        profileUrl: null,
        avatarUrl: null,
        enabled: true,
        source: 'test-seed',
        observedAt: new Date().toISOString(),
      });
      const firedAt = new Date(Date.now() - minutesAgo * 60_000).toISOString();
      const activationId = `act_seed_${Date.now()}_${candidateId}`;
      repo.createActivation(db, {
        activationId,
        candidateId,
        state: 'FIRED',
        startedAt: new Date(Date.now() - minutesAgo * 60_000 - 3_600_000).toISOString(),
        endedAt: firedAt,
        endReason: 'test seed',
        lossStreak: 2,
        firedReason: reason,
        source: 'test',
      });
      repo.insertFiringEvent(db, {
        activationId,
        candidateId,
        reason,
        lossStreak: 2,
        positionPolicy: 'close_all_before_switch',
        handoffStatus: 'none',
        firedAt,
      });
      rt.rebuildState();
      return c.json({ ok: true, candidateId, activationId });
    });
  }

  // ---- operations console (no-terminal command runner) --------------------------------
  app.get('/api/ops', requireAuth(sessions), (c) => {
    return c.json({ operations: rt.ops.catalog(), ...rt.ops.snapshot() });
  });

  app.post('/api/ops/:id/run', requireAuth(sessions), requireCsrf, async (c) => {
    const ip = c.req.header('x-forwarded-for') ?? 'local';
    const rl = controlLimiter.check(ip + ':ops');
    if (!rl.allowed) return c.json({ error: `rate limited; retry in ${rl.retryAfterSeconds}s` }, 429);
    const body = (await c.req.json().catch(() => ({}))) as { confirm?: string };
    const result = await rt.ops.run(c.req.param('id') ?? '', body.confirm);
    rt.rebuildState();
    if (!result.ok) {
      return c.json(
        { error: result.error ?? 'operation failed', code: result.code },
        result.code === 'CONFIRMATION_REQUIRED' ? 403 : 400,
      );
    }
    return c.json({ ok: true, run: result.run });
  });

  app.post('/api/ops/wallet', requireAuth(sessions), requireCsrf, async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { secret?: string; confirm?: string };
    const result = rt.ops.createWallet(body.secret ?? '', body.confirm ?? '');
    if (!result.ok) return c.json({ error: result.error }, 400);
    return c.json({ ok: true, publicKey: result.publicKey });
  });

  // ---- withdrawals (bankroll only; key unlocked in memory, never stored) -------------
  app.get('/api/wallet/withdrawable', requireAuth(sessions), async (c) => {
    return c.json(await rt.withdraw.available());
  });

  app.post('/api/wallet/withdraw', requireAuth(sessions), requireCsrf, async (c) => {
    const ip = c.req.header('x-forwarded-for') ?? 'local';
    const rl = controlLimiter.check(ip + ':withdraw');
    if (!rl.allowed) return c.json({ error: `rate limited; retry in ${rl.retryAfterSeconds}s` }, 429);
    const body = (await c.req.json().catch(() => ({}))) as {
      asset?: string;
      destination?: string;
      amount?: string;
      walletSecret?: string;
      confirm?: string;
      idempotencyKey?: string;
    };
    const result = await rt.withdraw.send({
      asset: body.asset === 'SOL' ? 'SOL' : 'USDC',
      destination: body.destination ?? '',
      amount: body.amount ?? '',
      walletSecret: body.walletSecret ?? '',
      confirm: body.confirm ?? '',
      idempotencyKey: body.idempotencyKey,
    });
    if (!result.ok) return c.json({ error: result.error, code: result.code }, 400);
    rt.rebuildState();
    return c.json(result);
  });

  // ---- provider keys (write-only; values are never echoed back) ------------------------
  app.post('/api/settings/keys', requireAuth(sessions), requireCsrf, async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      heliusApiKey?: string;
      jupiterApiKey?: string;
      jupiterBaseUrl?: string;
    } | null;
    if (!body) return c.json({ error: 'JSON body required' }, 400);
    const helius = body.heliusApiKey?.trim();
    const jupKey = body.jupiterApiKey?.trim();
    const jupBase = body.jupiterBaseUrl?.trim();
    if (helius !== undefined && (helius.length < 16 || /\s/.test(helius))) {
      return c.json({ error: 'That Helius key looks invalid (too short, or contains spaces).' }, 400);
    }
    if (jupKey !== undefined && (jupKey.length < 8 || /\s/.test(jupKey))) {
      return c.json({ error: 'That Jupiter key looks invalid (too short, or contains spaces).' }, 400);
    }
    if (jupBase !== undefined && !/^https:\/\/[\w.-]+/.test(jupBase)) {
      return c.json({ error: 'Jupiter URL must be an https:// address.' }, 400);
    }
    if (!helius && !jupKey && !jupBase) return c.json({ error: 'Nothing to update.' }, 400);
    const result = rt.applyProviderKeys({
      heliusApiKey: helius,
      jupiterApiKey: jupKey,
      jupiterBaseUrl: jupBase,
    });

    // Instant feedback: verify the saved Helius key against the live RPC so a
    // mistyped copy is caught now, not hours later. Skipped in tests to keep
    // them hermetic.
    let heliusCheck: { ok: boolean; detail: string } | null = null;
    if (helius && process.env.NODE_ENV !== 'test') {
      const check = await rt.helius
        .healthCheck()
        .catch((e: Error): { ok: boolean; detail: string; latencyMs?: number } => ({
          ok: false,
          detail: e.message,
        }));
      heliusCheck = { ok: check.ok, detail: check.ok ? 'RPC reachable' : (check.detail ?? 'unreachable') };
      repo.recordProviderHealth(db, {
        provider: 'helius',
        status: check.ok ? 'ok' : 'down',
        latencyMs: check.latencyMs ?? null,
        detail: check.ok
          ? 'key saved from SETTINGS; connection verified'
          : `key check failed: ${check.detail}`,
        checkedAt: new Date().toISOString(),
      });
    }

    rt.rebuildState();
    return c.json({ ok: true, ...result, heliusCheck });
  });

  // ---- control endpoints -------------------------------------------------------------
  const controlRoute = (
    path: string,
    fn: (c: import('hono').Context<AppEnv>) => Promise<unknown> | unknown,
  ) => {
    app.post(path, requireAuth(sessions), requireCsrf, async (c) => {
      const ip = c.req.header('x-forwarded-for') ?? 'local';
      const rl = controlLimiter.check(ip + path);
      if (!rl.allowed) return c.json({ error: `rate limited; retry in ${rl.retryAfterSeconds}s` }, 429);
      const out = (await fn(c)) as Record<string, unknown> | undefined;
      rt.rebuildState();
      if (out && typeof out === 'object' && 'error' in out) return c.json(out, 400);
      return c.json(out ?? { ok: true });
    });
  };

  controlRoute('/api/control/pause', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { reason?: string };
    rt.control.pauseNewEntries(body.reason?.slice(0, 200) || 'paused from dashboard');
    return { ok: true };
  });
  controlRoute('/api/control/resume', () => {
    rt.control.resumeNewEntries();
    return { ok: true };
  });
  controlRoute('/api/control/emergency-stop', () => {
    rt.control.emergencyStop();
    return {
      ok: true,
      note: 'new entries blocked; risk-reducing exits remain signable; use close-all to flatten, then lock-wallet',
    };
  });
  controlRoute('/api/control/emergency-clear', () => {
    rt.control.clearEmergency();
    return { ok: true };
  });
  controlRoute('/api/control/close-all', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { confirm?: string };
    if (body.confirm !== 'CLOSE-ALL') {
      return { error: 'close-all requires {"confirm":"CLOSE-ALL"}' };
    }
    const result = await rt.closeAllPositions('manual_close_all');
    return { ok: true, result };
  });

  // Retries reconciliation cases whose intent has NO signature (provably never
  // submitted) and completes the fire the failed close blocked. Cases with a
  // signature are never retried: their outcome is genuinely ambiguous.
  controlRoute('/api/control/retry-reconciliation-closes', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { confirm?: string };
    if (body.confirm !== 'RETRY-CLOSE') {
      return { error: 'retry-reconciliation-closes requires {"confirm":"RETRY-CLOSE"}' };
    }
    const result = await rt.lifecycle.retrySignaturelessCloses('manual_reconciliation_retry');
    rt.rebuildState();
    return { ok: true, result };
  });

  controlRoute('/api/control/reconcile-now', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { confirm?: string };
    if (body.confirm !== 'RECONCILE') {
      return { error: 'reconcile-now requires {"confirm":"RECONCILE"}' };
    }
    const result = await rt.reconcileNow();
    return { ok: true, result };
  });

  app.post('/api/control/arm-live', requireAuth(sessions), requireCsrf, async (c) => {
    const ip = c.req.header('x-forwarded-for') ?? 'local';
    const rl = controlLimiter.check(ip + 'arm-live');
    if (!rl.allowed) return c.json({ error: `rate limited; retry in ${rl.retryAfterSeconds}s` }, 429);
    if (rt.config.mode !== 'live') return c.json({ error: 'MODE is not live' }, 400);
    const readiness = await rt.readiness();
    rt.setLiveReadiness(readiness.ready);
    if (!readiness.ready) {
      repo.audit(db, 'control', 'arm-live refused: readiness blockers', {
        blockers: readiness.items
          .filter((item) => item.severity === 'blocker' && !item.ok)
          .map((item) => item.id),
      });
      return c.json({ error: 'readiness blockers remain', readiness }, 400);
    }
    if (!rt.config.env.LIVE_TRADING) {
      return c.json({ error: 'LIVE_TRADING is false; signing is disabled' }, 409);
    }
    const body = (await c.req.json().catch(() => ({}))) as { ack?: string; walletSecret?: string };
    if (body.ack !== LIVE_ACK_STRING) {
      repo.audit(db, 'control', 'arm-live refused: confirmation string mismatch');
      return c.json(
        { error: `ack must equal the documented confirmation string`, expected: LIVE_ACK_STRING },
        400,
      );
    }
    const passphrase = rt.config.env.COPYDESK_WALLET_PASSPHRASE || (body.walletSecret ?? '');
    let secret: Uint8Array;
    try {
      secret = loadWalletSecret(rt.config.env.DATA_DIR, passphrase, rt.config.env.WALLET_FILE);
    } catch (e) {
      repo.audit(db, 'control', 'arm-live refused: wallet unlock failed', {
        error: (e as Error).message,
      });
      return c.json({ error: `wallet unlock failed: ${(e as Error).message}` }, 400);
    }
    // Seal the ACTUAL passphrase (env or body) so a restart can restore live
    // arming. A sealing failure only means the next restart disarms.
    let survivesRestart = false;
    try {
      survivesRestart = rememberWalletPassphrase(rt.config.env.DATA_DIR, passphrase);
      if (!survivesRestart) {
        repo.audit(
          db,
          'control',
          'wallet passphrase not sealed (unsupported platform) — restart will disarm',
        );
      }
    } catch (e) {
      repo.audit(db, 'control', 'wallet passphrase could not be sealed — restart will disarm', {
        error: (e as Error).message,
      });
    }
    let pk: string | null = null;
    try {
      pk = walletPublicKey(rt.config.env.DATA_DIR, rt.config.env.WALLET_FILE);
    } catch {
      pk = null;
    }
    if (!pk) return c.json({ error: 'wallet public key is unreadable' }, 400);
    rt.mountLiveExecutor(
      new LiveExecutor(rt.jupiter, rt.heliusRpcUrl(), secret, pk, undefined, rt.liveSubmit()),
    );
    rt.control.armLive();
    repo.audit(db, 'control', 'arm-live succeeded', { survivesRestart });
    rt.rebuildState();
    return c.json({
      ok: true,
      note: 'LIVE armed. Labels now display LIVE.',
      survivesRestart,
    });
  });

  controlRoute('/api/control/disarm', () => {
    // Exits stay signable: the executor is intentionally NOT unmounted here.
    rt.control.disarm();
    return { ok: true, note: 'new entries stopped; exits remain signable' };
  });

  controlRoute('/api/control/lock-wallet', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { confirm?: string };
    if (body.confirm !== 'LOCK-WALLET') {
      return { error: 'lock-wallet requires {"confirm":"LOCK-WALLET"}' };
    }
    const liveMode = rt.config.mode === 'live' ? 'live' : 'paper';
    if (
      repo.exposurePositions(db, liveMode).length > 0 ||
      repo.openReconciliationCases(db, liveMode).length > 0 ||
      repo.signedIntents(db, liveMode).length > 0
    ) {
      return {
        error:
          'cannot lock the wallet while live positions, signed orders or reconciliation cases remain; close-all and resolve first',
      };
    }
    rt.unmountLiveExecutor();
    rt.control.lockWallet();
    return { ok: true };
  });

  // ---- demo replay controls --------------------------------------------------------------
  app.post('/api/demo/start', requireAuth(sessions), requireCsrf, (c) => {
    if (rt.config.mode !== 'demo') return c.json({ error: 'demo replay only available in demo mode' }, 400);
    rt.startDemo();
    return c.json({ ok: true });
  });

  app.get('/api/wallet/public-key', requireAuth(sessions), (c) => {
    let pk: string | null = null;
    try {
      pk = walletPublicKey(rt.config.env.DATA_DIR, rt.config.env.WALLET_FILE);
    } catch {
      pk = null;
    }
    return c.json({ publicKey: pk });
  });

  app.notFound((c) => c.json({ error: 'not found' }, 404));
  return app;
}
