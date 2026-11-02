# ZCode automation — RETIRED (D6)

The ZCode research pipeline is **retired**. Removed: the sanitized research
snapshot and `snapshot-rebuild`, the restricted three-tool MCP server
(`apps/zcode-mcp`), the pinned `zcode-research` agent, ordering
validation/TTL/replay, the handoff and rotation machinery, the 5-minute research
tick and the `research_request`/`research_dispatched` control events.

Admission is deterministic and lives in the server process (D3/D4/D5): the
fomoapi discovery inlet → watch list → shadow ledger → promotion queue →
roster. See `DECISIONS.md` (D2–D6) and `IMPLEMENTATION_PLANS/README.md`.

ZCode itself stays available for manual runs, summaries and optional native
verification — it is simply no longer part of the trading loop.
