#!/usr/bin/env python3
"""Long-lived Helius/desk monitor. Stops Copydesk if sustained spend would exceed 13.6k/day."""
from __future__ import annotations

import collections
import json
import sqlite3
import subprocess
import sys
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path

ROOT = Path(r"C:\Users\atavi\Documents\projects\copydesk")
LOGS = ROOT / "logs"
HELIUS = LOGS / "helius-credits.jsonl"
FOMO = LOGS / "fomo-credits.jsonl"
DB = ROOT / "data" / "zcode-bot.db"
OUT = LOGS / "credit-guard.log"
PID = LOGS / "credit-guard.pid"
STOP = LOGS / "overnight-monitor.stop"
SERVICE = ROOT / "scripts" / "copydesk-service.ps1"
DAILY_HARD_CAP = 13_600
TICKS_PER_DAY = 288
EET = timezone(timedelta(hours=2))


def log(msg: str) -> None:
    line = f"{datetime.now(EET).isoformat()} {msg}"
    print(line, flush=True)
    LOGS.mkdir(parents=True, exist_ok=True)
    with OUT.open("a", encoding="utf-8") as fh:
        fh.write(line + "\n")


def load_since(path: Path, since_ts: float):
    if not path.exists():
        return []
    rows = []
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        if not line.strip():
            continue
        r = json.loads(line)
        if r.get("ts", 0) >= since_ts:
            rows.append(r)
    return rows


def db_snap():
    try:
        uri = "file:" + str(DB).replace("\\", "/") + "?mode=ro"
        con = sqlite3.connect(uri, uri=True)
        cur = con.cursor()

        def c(q):
            try:
                return cur.execute(q).fetchone()[0]
            except sqlite3.Error:
                return None

        snap = {
            "watch": c("SELECT COUNT(*) FROM watch_wallets"),
            "hired": c("SELECT COUNT(*) FROM trader_activations WHERE state='ACTIVE'"),
            "shadow_open": c("SELECT COUNT(*) FROM shadow_trades WHERE status='open'"),
            "shadow_closed": c("SELECT COUNT(*) FROM shadow_trades WHERE status='closed'"),
            "fills": c("SELECT COUNT(*) FROM fills"),
            "positions": c("SELECT COUNT(*) FROM copied_positions"),
        }
        con.close()
        return snap
    except Exception as e:
        return {"error": str(e)}


def window_credits(rows, now, seconds):
    cut = now - seconds * 1000
    http = [
        r
        for r in rows
        if r.get("ts", 0) >= cut
        and r.get("transport") != "ws"
        and r.get("method") not in {"wssChunk", "wssOpen"}
    ]
    credits = sum(r.get("credits") or 0 for r in http)
    statuses = collections.Counter(r.get("status") for r in http)
    methods = collections.Counter(r.get("method") for r in http)
    return credits, len(http), statuses, methods


def service_up() -> bool:
    r = subprocess.run(
        [
            "powershell.exe",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(SERVICE),
            "status",
        ],
        capture_output=True,
        text=True,
    )
    return "server running" in (r.stdout or "") and "listening" in (r.stdout or "")


def stop_service() -> None:
    subprocess.run(
        [
            "powershell.exe",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(SERVICE),
            "stop",
        ],
        check=False,
    )


def main():
    LOGS.mkdir(parents=True, exist_ok=True)
    PID.write_text(str(__import__("os").getpid()) + "\n", encoding="utf-8")
    started = time.time()
    log("credit-guard start")
    history = []
    last_mark = started
    last_total = 0
    while True:
        if STOP.exists():
            log("stop file present — exiting")
            break
        now = time.time()
        now_ms = now * 1000
        rows = load_since(HELIUS, (started - 60) * 1000)
        c5, n5, st5, m5 = window_credits(rows, now_ms, 300)
        c15, n15, st15, m15 = window_credits(rows, now_ms, 900)
        c60, n60, st60, m60 = window_credits(rows, now_ms, 3600)
        if now - last_mark >= 300:
            total = sum(
                r.get("credits") or 0
                for r in rows
                if r.get("transport") != "ws" and r.get("method") not in {"wssChunk", "wssOpen"}
            )
            delta = max(0, total - last_total) if last_total else c5
            history.append((now, delta))
            last_total = total
            last_mark = now
            history = history[-12:]
        daily = None
        basis = "warming up"
        if len(history) >= 3:
            avg = sum(h[1] for h in history[-3:]) / 3
            daily = avg * TICKS_PER_DAY
            basis = f"mean last three 5m windows {avg:.1f} x 288"
        elif now - started >= 900:
            daily = c15 / 15 * 60 * 24
            basis = f"15m rate {c15} credits"
        fomo = load_since(FOMO, started * 1000)
        fomo_c = sum(r.get("credits") or 0 for r in fomo)
        fomo_left = fomo[-1].get("creditsRemaining") if fomo else None
        snap = db_snap()
        up = service_up()
        log(
            f"up={up} 5m={c5}c/{n5} 15m={c15}c/{n15} 60m={c60}c/{n60} "
            f"429s_15m={st15.get(429,0)} proj={None if daily is None else round(daily)} ({basis}) "
            f"fomo_session={fomo_c} left={fomo_left} desk={snap}"
        )
        if not up:
            log("service not running — monitor stays alive and will keep checking")
        if daily is not None and daily > DAILY_HARD_CAP and c15 >= 40:
            log(f"ABORT: projected {daily:.0f}/day exceeds {DAILY_HARD_CAP} ({basis})")
            stop_service()
            LOGS.joinpath("ABORT_REASON.txt").write_text(
                f"{datetime.now(EET).isoformat()} credit-guard: projected {daily:.0f}/day ({basis})\n",
                encoding="utf-8",
            )
            break
        if st15.get(429, 0) >= 20:
            log(f"ABORT: {st15.get(429)} Helius 429s in 15 minutes")
            stop_service()
            LOGS.joinpath("ABORT_REASON.txt").write_text(
                f"{datetime.now(EET).isoformat()} credit-guard: 429 storm {st15.get(429)} in 15m\n",
                encoding="utf-8",
            )
            break
        time.sleep(60)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        log(f"credit-guard crashed: {exc}")
        sys.exit(1)
