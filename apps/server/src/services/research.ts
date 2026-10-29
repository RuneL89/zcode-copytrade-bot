import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AppDatabase } from '@zcode-bot/db';
import * as repo from '@zcode-bot/db/repo.js';
import {
  ACTIVITY_FRESH_MS,
  snapshotHash,
  validateRecommendation,
  type ResearchSnapshot,
  type SanitizedCandidate,
  type RecommendationPayload,
} from '@zcode-bot/core';
import type { RiskConfig } from '@zcode-bot/config';

/** A candidate whose leaderboard observation is older than this is "stale". */
const STALE_CANDIDATE_AGE_MS = 24 * 60 * 60 * 1000;
/** Machine-readable prefix the researcher uses to request a leaderboard refresh. */
export const POOL_STALE_PREFIX = 'POOL_STALE';

/**
 * Research plumbing between the worker and the restricted ZCode MCP server:
 * - writes a SANITIZED snapshot to DATA_DIR/research/snapshot/snapshot.json
 *   (the only research input the MCP process may read);
 * - ingests recommendations from DATA_DIR/research/inbox (atomic file drops)
 *   or via the token-authenticated internal endpoint / dashboard import.
 * Nothing here can activate a trader, change risk, or execute anything.
 */

export class SnapshotService {
  constructor(
    private db: AppDatabase,
    private dataDir: string,
    private risk: RiskConfig,
  ) {}

  /** Build + persist a sanitized snapshot from current candidate data. */
  build(now = new Date()): ResearchSnapshot {
    const candidates = repo.listCandidates(this.db);
    const addresses = repo.listCandidateAddresses(this.db);
    const byCandidate = new Map<string, typeof addresses>();
    for (const a of addresses) {
      const list = byCandidate.get(a.candidateId) ?? [];
      list.push(a);
      byCandidate.set(a.candidateId, list);
    }
    const firedRecently = new Set(this.recentlyFiredCandidateIds(now));

    const sanitized: SanitizedCandidate[] = candidates.map((c) => {
      return {
        candidateId: c.candidateId,
        handle: c.handle.slice(0, 64),
        weeklyRank: c.weeklyRank,
        displayedWeeklyPnlUsdMicro: c.displayedWeeklyPnlUsdMicro,
        profileUrl: c.profileUrl,
        avatarUrl: c.avatarUrl,
        addresses: (byCandidate.get(c.candidateId) ?? []).map((a) => ({
          chain: a.chain,
          address: a.address,
          verification: a.verification === 'verified' ? 'verified' : 'reported',
        })),
        enabled: c.enabled,
        recentlyFired: firedRecently.has(c.candidateId),
        recentEligibilityFailures: [],
        publicStats: {
          winRatePct: c.winRatePct ?? null,
          tradesCount: c.tradesCount7d ?? c.tradesTotal ?? null,
          avgTradeUsdMicro: null,
          avgHoldHours: c.avgHoldHours ?? null,
          realizedOnchainUsd: c.realizedOnchainUsd ?? null,
          swaps24h: c.swaps24h ?? null,
          lastSwapAt: c.lastSwapAt ?? null,
          activityCheckedAt: c.activityCheckedAt ?? null,
          statsCheckedAt: c.statsCheckedAt ?? null,
          pnl24hUsd: c.pnl24hUsd ?? null,
          pnl7dUsd: c.pnl7dUsd ?? null,
          pnl30dUsd: c.pnl30dUsd ?? null,
          pnlAllTimeUsd: c.pnlAllTimeUsd ?? null,
          tradesTotal: c.tradesTotal ?? null,
          recentBuys: c.recentBuys ?? null,
          recentSells: c.recentSells ?? null,
          lastTradeAgeHours: c.lastTradeAgeHours ?? null,
        },
        observedAt: c.observedAt,
      };
    });

    const observedTimes = candidates.map((c) => Date.parse(c.observedAt)).filter((t) => Number.isFinite(t));
    const freshestObserved = observedTimes.length ? Math.max(...observedTimes) : null;
    const oldestObserved = observedTimes.length ? Math.min(...observedTimes) : null;
    const staleCutoff = now.getTime() - STALE_CANDIDATE_AGE_MS;
    // A candidate is stale only when BOTH stamps are old: a stale leaderboard
    // observation with a recently verified wallet (Helius) is still usable, so
    // counting it stale would misreport the pool to the researcher.
    const activityCutoff = now.getTime() - ACTIVITY_FRESH_MS;
    const staleCandidateCount = candidates.filter((c) => {
      const t = Date.parse(c.observedAt);
      const observationStale = !Number.isFinite(t) || t < staleCutoff;
      if (!observationStale) return false;
      const a = c.activityCheckedAt ? Date.parse(c.activityCheckedAt) : NaN;
      return !Number.isFinite(a) || a < activityCutoff;
    }).length;
    const snapshot: ResearchSnapshot = {
      snapshotId: 'snap_' + randomUUID(),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.risk.RECOMMENDATION_TTL_MS).toISOString(),
      // Age of the NEWEST leaderboard observation: a freshly imported board makes
      // this small even while older rows are still in the pool.
      sourceFreshnessSeconds:
        freshestObserved !== null ? Math.max(0, Math.round((now.getTime() - freshestObserved) / 1000)) : 0,
      oldestObservedAt: oldestObserved !== null ? new Date(oldestObserved).toISOString() : null,
      staleCandidateCount,
      candidates: sanitized,
    };
    const hash = snapshotHash(snapshot);
    repo.saveSnapshot(this.db, {
      snapshotId: snapshot.snapshotId,
      createdAt: snapshot.createdAt,
      expiresAt: snapshot.expiresAt,
      sourceFreshnessSeconds: snapshot.sourceFreshnessSeconds,
      hash,
      payloadJson: JSON.stringify(snapshot),
    });
    const dir = join(this.dataDir, 'research', 'snapshot');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'snapshot.json'), JSON.stringify({ ...snapshot, hash }, null, 2));
    repo.audit(this.db, 'research', 'research snapshot published', {
      snapshotId: snapshot.snapshotId,
      candidates: sanitized.length,
    });
    return snapshot;
  }

  /** Candidates fired within the cooldown window (sanitized flag only). */
  recentlyFiredCandidateIds(now: Date): string[] {
    const since = new Date(now.getTime() - this.risk.FIRED_TRADER_COOLDOWN_MS).toISOString();
    const activations = repo.listActivations(this.db, 200);
    return activations
      .filter((a) => a.state === 'FIRED' && a.endedAt !== null && a.endedAt >= since)
      .map((a) => a.candidateId);
  }

  currentSnapshot(): ResearchSnapshot | null {
    const row = repo.latestSnapshot(this.db);
    if (!row) return null;
    return JSON.parse(row.payloadJson) as ResearchSnapshot;
  }
}

export class RecommendationService {
  constructor(
    private db: AppDatabase,
    private snapshots: SnapshotService,
    private risk: RiskConfig,
  ) {}

  /** Validate + store a submitted recommendation. Returns the verdict. */
  ingest(
    payload: unknown,
    now = new Date(),
  ): { ok: boolean; code?: string; message?: string; recommendationId?: string } {
    const snapshot = this.snapshots.currentSnapshot();
    if (!snapshot) {
      return {
        ok: false,
        code: 'NO_SNAPSHOT',
        message: 'no research snapshot exists yet; wait for the worker to publish one',
      };
    }
    const seen = new Set(repo.listRecommendations(this.db, 500).map((r) => r.recommendationId));
    const verdict = validateRecommendation(payload, { snapshot, now, seenRecommendationIds: seen });
    const raw = JSON.stringify(payload);
    if (!verdict.ok) {
      const rec = payload as { recommendationId?: string };
      if (rec?.recommendationId) {
        repo.saveRecommendation(
          this.db,
          {
            recommendationId: rec.recommendationId,
            snapshotId: snapshot.snapshotId,
            snapshotHash: '0'.repeat(64),
            createdAt: now.toISOString(),
            receivedAt: now.toISOString(),
            expiresAt: now.toISOString(),
            modelLabel: null,
            researchSessionId: null,
            abstain: false,
            abstainReason: null,
            status: 'rejected',
            validationError: `${verdict.code}: ${verdict.message}`,
            rawJson: raw.slice(0, 20_000),
            normalizedJson: null,
          },
          [],
        );
      }
      repo.audit(this.db, 'recommendation', 'recommendation REJECTED', {
        code: verdict.code,
        message: verdict.message,
      });
      return { ok: false, code: verdict.code, message: verdict.message };
    }
    const rec = verdict.recommendation;
    repo.saveRecommendation(
      this.db,
      {
        recommendationId: rec.recommendationId,
        snapshotId: rec.snapshotId,
        snapshotHash: rec.snapshotHash,
        createdAt: rec.createdAt,
        receivedAt: verdict.normalizedAt,
        expiresAt: rec.expiresAt,
        modelLabel: rec.modelLabel ?? null,
        researchSessionId: rec.researchSessionId ?? null,
        abstain: rec.abstain,
        abstainReason: rec.abstainReason,
        status: rec.abstain ? 'consumed' : 'validated',
        validationError: null,
        rawJson: raw.slice(0, 20_000),
        normalizedJson: JSON.stringify(rec),
      },
      rec.orderedCandidates.map((c) => ({
        recommendationId: rec.recommendationId,
        rank: c.rank,
        candidateId: c.candidateId,
        confidence: String(c.confidence),
        thesis: c.thesis,
        concernsJson: JSON.stringify(c.concerns),
        evidenceJson: JSON.stringify(c.evidence),
      })),
    );
    repo.audit(
      this.db,
      'recommendation',
      rec.abstain ? 'recommendation ABSTAINED' : 'recommendation validated',
      {
        recommendationId: rec.recommendationId,
        ordered: rec.orderedCandidates.map((c) => ({ rank: c.rank, candidateId: c.candidateId })),
      },
    );

    // The researcher asks for a fresh leaderboard by abstaining with a POOL_STALE
    // reason. Record it durably so the sweep can see an unfulfilled request.
    if (rec.abstain && (rec.abstainReason ?? '').trimStart().toUpperCase().startsWith(POOL_STALE_PREFIX)) {
      repo.controlEvent(
        this.db,
        'leaderboard_refresh_request',
        rec.abstainReason ?? POOL_STALE_PREFIX,
        'research',
      );
      repo.audit(this.db, 'research', 'leaderboard refresh requested (POOL_STALE)', {
        recommendationId: rec.recommendationId,
        sourceFreshnessSeconds: snapshot.sourceFreshnessSeconds,
        staleCandidateCount: snapshot.staleCandidateCount ?? null,
      });
    }

    // A fresh ordering may ask the engine to rotate the active trader when it is
    // flat. The handler decides; nothing here can fire or activate on its own.
    if (!rec.abstain && rec.rotateIfFlat) {
      this.onRotationRequest?.(rec);
    }

    return { ok: true, recommendationId: rec.recommendationId };
  }

  /**
   * Wired by the runtime to TraderLifecycle.rotateIfFlat. Kept as a callback so the
   * research service never holds a reference to the trading engine.
   */
  onRotationRequest: ((rec: RecommendationPayload) => void) | null = null;

  latestValid(): { payload: RecommendationPayload; receivedAt: string } | null {
    const rows = repo.listRecommendations(this.db, 50);
    const valid = rows.find((r) => r.status === 'validated' && Date.parse(r.expiresAt) > Date.now());
    if (!valid) return null;
    return {
      payload: JSON.parse(valid.normalizedJson ?? '{}') as RecommendationPayload,
      receivedAt: valid.receivedAt,
    };
  }

  latestAny() {
    return repo.listRecommendations(this.db, 1)[0] ?? null;
  }

  /** Scan + validate inbox files (atomic tmp-then-rename writes from MCP). */
  ingestInboxOnce(inboxDir: string): number {
    if (!existsSync(inboxDir)) return 0;
    let count = 0;
    for (const name of readdirSync(inboxDir)) {
      if (!name.endsWith('.json')) continue;
      const path = join(inboxDir, name);
      try {
        const payload = JSON.parse(readFileSync(path, 'utf8'));
        const verdict = this.ingest(payload);
        count++;
        if (!verdict.ok) {
          repo.audit(this.db, 'recommendation', 'inbox file rejected', { file: name, code: verdict.code });
        }
      } catch (e) {
        repo.audit(this.db, 'recommendation', 'inbox file unreadable', {
          file: name,
          error: (e as Error).message,
        });
      } finally {
        const processedDir = resolve(inboxDir, '..', 'processed');
        mkdirSync(processedDir, { recursive: true });
        try {
          renameSync(path, join(processedDir, name));
        } catch {
          /* best effort */
        }
      }
    }
    return count;
  }

  ttlMs(): number {
    return this.risk.RECOMMENDATION_TTL_MS;
  }

  /** Snapshot access for the lifecycle/builder services. */
  currentSnapshotForLifecycle(): ResearchSnapshot | null {
    return this.snapshots.currentSnapshot();
  }
}
