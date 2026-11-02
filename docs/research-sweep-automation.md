# Research sweep — RETIRED (D3/D6)

Both the 5-minute research tick and the 30-minute data sweep are retired. The
discovery inlet is the fomoapi leaderboard (`DiscoveryService`, demand-driven:
it runs only when the bench is below `BENCH_TARGET` or a chair is free with no
promotable wallet behind it, rate-limited by `DISCOVERY_MIN_INTERVAL_MS`), the
watch list polls every `WATCH_POLL_MS`, and the roster polls every
`ROSTER_POLL_MS`. The native desktop-Chrome capture and Dawn remain documented
FALLBACK procedures in `docs/FOMO_DAWN_FETCHING.md`.

Nothing in this repository should recreate the sweeps. See `DECISIONS.md` D3/D5/D6.
