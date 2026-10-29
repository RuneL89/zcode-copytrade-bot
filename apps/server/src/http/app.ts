import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { AppDatabase } from '@zcode-bot/db';
import * as repo from '@zcode-bot/db/repo.js';
import { settingsPatchSchema, LIVE_ACK_STRING } from '@zcode-bot/config';
import { parseManualCsv, parseManualJson } from '@zcode-bot/providers';
import { snapshotHash } from '@zcode-bot/core';
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
import { LiveExecutor } from '../services/executors.js';

export function buildApp(rt: Runtime): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const sessions = new SessionManager(rt.config.env.SESSION_SECRET);
  const db: AppDatabase = rt.db.db;

  // ---- public bootstrap -----------------------------------------------------
  app.get('/api/bootstrap', (c) => {
    const needsSetup = repo.countUsers(db) === 0;
    const state = rt.store.get();
    return c.json({
      needsSetup,
      mode: rt.config.mode,
      armed: rt.control.flags.armed,
      fictional: rt.config.mode === 'demo',
      appState: state?.appState ?? 'PAUSED_WAITING_FOR_CANDIDATE',
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
    c.json({ activations: repo.listActivations(db, 100) }),
  );
  app.get('/api/positions', requireAuth(sessions), (c) => c.json({ positions: repo.listPositions(db, 200) }));
  app.get('/api/closes', requireAuth(sessions), (c) => c.json({ lots: repo.listPnlLots(db, 500) }));
  app.get('/api/recommendation', requireAuth(sessions), (c) => {
    const rows = repo.listRecommendations(db, 20).map((r) => ({
      recommendationId: r.recommendationId,
      status: r.status,
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
      modelLabel: r.modelLabel,
      abstain: r.abstain,
      abstainReason: r.abstainReason,
      validationError: r.validationError,
      candidates: repo.listRecommendationCandidates(db, r.recommendationId).map((c2) => ({
        rank: c2.rank,
        candidateId: c2.candidateId,
        confidence: Number(c2.confidence),
        thesis: c2.thesis,
        concerns: JSON.parse(c2.concernsJson) as string[],
      })),
    }));
    return c.json({ recommendations: rows });
  });
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
  app.get('/api/rejections', requireAuth(sessions), (c) =>
    c.json({ rejections: repo.listRiskRejections(db, 300) }),
  );
  app.get('/api/reconciliation', requireAuth(sessions), (c) =>
    c.json({ cases: repo.openReconciliationCases(db) }),
  );
  app.get('/api/observed-events', requireAuth(sessions), (c) =>
    c.json({ events: repo.listObservedEvents(db, undefined, 200) }),
  );

  // ---- settings -----------------------------------------------------------------
  app.get('/api/settings', requireAuth(sessions), (c) => {
    return c.json({
      mode: rt.config.mode,
      armed: rt.control.flags.armed && rt.config.mode === 'live',
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
      },
      wallet: {
        exists: Boolean(walletPublicKey(rt.config.env.DATA_DIR)),
        publicKey: walletPublicKey(rt.config.env.DATA_DIR),
      },
      snapshot: rt.snapshots.currentSnapshot()
        ? {
            snapshotId: rt.snapshots.currentSnapshot()!.snapshotId,
            hash: snapshotHash(rt.snapshots.currentSnapshot()!),
            createdAt: rt.snapshots.currentSnapshot()!.createdAt,
            candidates: rt.snapshots.currentSnapshot()!.candidates.length,
          }
        : null,
      readiness: rt.readiness(),
      control: rt.control.flags,
      liveAckString: LIVE_ACK_STRING,
    });
  });

  app.patch('/api/settings', requireAuth(sessions), requireCsrf, async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = settingsPatchSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          error: 'invalid settings patch',
          issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
        },
        400,
      );
    }
    rt.applySettings(parsed.data);
    repo.audit(db, 'settings', 'risk settings updated', redact(parsed.data));
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
      const candidateId = 'cand_' + entry.handle.toLowerCase().replace(/[^a-z0-9_]+/g, '_');
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
    rt.rebuildSnapshot();
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
    const body = await c.req.json().catch(() => null);
    const { candidateId } = (body ?? {}) as { candidateId?: string };
    if (!candidateId) return c.json({ error: 'candidateId required' }, 400);
    const result = await rt.lifecycle.activate(candidateId, 'manual', true);
    rt.rebuildState();
    if (!result.ok) return c.json({ error: result.reason }, 400);
    return c.json({ ok: true, activationId: result.activationId });
  });

  app.post('/api/fire', requireAuth(sessions), requireCsrf, async (c) => {
    const active = repo.activeActivation(db);
    if (!active) return c.json({ error: 'no active trader' }, 400);
    const outcome = await rt.lifecycle.fire(active.activationId, 'manual fire from dashboard');
    rt.rebuildState();
    return c.json({ ok: true, outcome });
  });

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
    };
    const result = await rt.withdraw.send({
      asset: body.asset === 'SOL' ? 'SOL' : 'USDC',
      destination: body.destination ?? '',
      amount: body.amount ?? '',
      walletSecret: body.walletSecret ?? '',
      confirm: body.confirm ?? '',
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
      note: 'new entries and non-risk-reducing signing blocked; already-submitted transactions cannot be recalled',
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

  app.post('/api/control/arm-live', requireAuth(sessions), requireCsrf, async (c) => {
    if (rt.config.mode !== 'live') return c.json({ error: 'MODE is not live' }, 400);
    const readiness = rt.readiness();
    if (!readiness.ready) {
      return c.json({ error: 'readiness blockers remain', readiness }, 400);
    }
    const body = (await c.req.json().catch(() => ({}))) as { ack?: string; walletSecret?: string };
    if (body.ack !== LIVE_ACK_STRING) {
      return c.json(
        { error: `ack must equal the documented confirmation string`, expected: LIVE_ACK_STRING },
        400,
      );
    }
    let secret: Uint8Array;
    try {
      secret = loadWalletSecret(rt.config.env.DATA_DIR, body.walletSecret ?? '');
    } catch (e) {
      return c.json({ error: `wallet unlock failed: ${(e as Error).message}` }, 400);
    }
    const pk = walletPublicKey(rt.config.env.DATA_DIR)!;
    rt.mountLiveExecutor(new LiveExecutor(rt.jupiter, rt.heliusRpcUrl(), secret, pk));
    rt.control.armLive();
    rt.rebuildState();
    return c.json({ ok: true, note: 'LIVE armed. Labels now display LIVE.' });
  });

  controlRoute('/api/control/disarm', () => {
    rt.control.disarm();
    rt.unmountLiveExecutor();
    return { ok: true };
  });

  // ---- recommendation import (JSON-file fallback, same validation) ---------------------
  app.post('/api/recommendation/import', requireAuth(sessions), requireCsrf, async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object') return c.json({ error: 'JSON payload required' }, 400);
    const verdict = rt.recommendations.ingest(body);
    rt.rebuildState();
    return c.json(verdict, verdict.ok ? 200 : 422);
  });

  // ---- internal MCP submission endpoint (local random token) ----------------------------
  app.post('/internal/recommendation', async (c) => {
    const token = c.req.header('x-submit-token');
    if (!token || !rt.checkSubmitToken(token)) return c.json({ error: 'invalid submit token' }, 403);
    const body = await c.req.json().catch(() => null);
    const verdict = rt.recommendations.ingest(body);
    rt.rebuildState();
    return c.json(verdict, verdict.ok ? 200 : 422);
  });

  // ---- demo replay controls --------------------------------------------------------------
  app.post('/api/demo/start', requireAuth(sessions), requireCsrf, (c) => {
    if (rt.config.mode !== 'demo') return c.json({ error: 'demo replay only available in demo mode' }, 400);
    rt.startDemo();
    return c.json({ ok: true });
  });

  app.get('/api/wallet/public-key', requireAuth(sessions), (c) => {
    const pk = walletPublicKey(rt.config.env.DATA_DIR);
    return c.json({ publicKey: pk });
  });

  app.notFound((c) => c.json({ error: 'not found' }, 404));
  return app;
}
