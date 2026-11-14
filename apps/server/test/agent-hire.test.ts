import { describe, expect, it } from 'vitest';
import { SEAT_DECISION_MS, dueSeatTimeouts, type OpenSeat } from '../src/services/agentHooks.js';

const seat = (over: Partial<OpenSeat> = {}): OpenSeat => ({
  activationId: 'act',
  candidateId: 'cand',
  reason: 'fired',
  atMs: 0,
  pinged: false,
  ...over,
});

describe('agent seat timeout', () => {
  it('leaves the seat empty until 15 minutes, then only pings', () => {
    const opens = [seat()];
    expect(dueSeatTimeouts(opens, SEAT_DECISION_MS - 1)).toEqual([]);
    expect(dueSeatTimeouts(opens, SEAT_DECISION_MS)).toEqual(opens);
    expect(dueSeatTimeouts([seat({ pinged: true })], SEAT_DECISION_MS + 1)).toEqual([]);
  });
});
