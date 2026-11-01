import type { AppDatabase } from '@zcode-bot/db';
import * as repo from '@zcode-bot/db/repo.js';

/**
 * Silent-Dawn parks (operator directive, 2026-11-01).
 *
 * Two consecutive no-card runs park a handle for 6 hours. A handle that stays
 * silent across three or more runs is dead on Dawn's side — every retry costs
 * two 45-second waits in the operator's browser and returns nothing — so it is
 * parked for a week instead of being re-attempted every sweep.
 *
 * Shared by the runtime's scheduled lookup and the `dawn-lookup` CLI: without
 * this the CLI's `--all-missing` rebuilt its own target list and kept retrying
 * handles the server had already parked.
 */
const SHORT_PARK_MS = 6 * 3600_000;
const DEAD_PARK_MS = 7 * 24 * 3600_000;

export interface DawnParkState {
  consecutive: number;
  lastAt: string;
  expiresAt: string;
}

/** Park state for a candidate, or null when it has never been silent. */
export function dawnParkState(db: AppDatabase, candidateId: string, now = Date.now()): DawnParkState | null {
  const raw = repo.kvGet(db, `dawn.noCard:${candidateId}`);
  if (!raw) return null;
  let parsed: { count?: number; at?: string };
  try {
    parsed = JSON.parse(raw) as { count?: number; at?: string };
  } catch {
    return null;
  }
  const count = parsed.count ?? 0;
  const at = parsed.at ?? '';
  const atMs = Date.parse(at);
  if (count < 2 || !Number.isFinite(atMs)) return null;
  const windowMs = count >= 3 ? DEAD_PARK_MS : SHORT_PARK_MS;
  return {
    consecutive: count,
    lastAt: at,
    expiresAt: new Date(atMs + windowMs).toISOString(),
  };
}

/** True while a silent handle's park has not expired. */
export function isDawnParked(db: AppDatabase, candidateId: string, now = Date.now()): boolean {
  const state = dawnParkState(db, candidateId, now);
  return state !== null && Date.parse(state.expiresAt) > now;
}
