import json, time, collections, sqlite3
from pathlib import Path
from datetime import datetime, timezone, timedelta
EET=timezone(timedelta(hours=2))
ROOT=Path(r"C:\Users\atavi\Documents\projects\copydesk")
LOG=ROOT/"logs"/"helius-credits.jsonl"
OUT=ROOT/"logs"/"pc-15min-watch.log"
DURATION=15*60
SAMPLE=20
DAILY_HARD_CAP=13600
started=time.time()
since=int(started*1000)
OUT.write_text(f"PC watch {DURATION}s starting {datetime.now(EET).isoformat()}\n", encoding="utf-8")
def load():
    if not LOG.exists():
        return []
    rows=[]
    for line in LOG.read_text(encoding="utf-8").splitlines():
        if line.strip():
            r=json.loads(line)
            if r.get("ts",0)>=since:
                rows.append(r)
    return rows
while True:
    elapsed=time.time()-started
    rows=load()
    http=[r for r in rows if r.get("transport")!="ws" and r.get("method") not in {"wssChunk","wssOpen"}]
    ws=[r for r in rows if r.get("transport")=="ws" or r.get("method") in {"wssChunk","wssOpen"}]
    http_c=sum(r.get("credits") or 0 for r in http)
    ws_c=sum(r.get("credits") or 0 for r in ws)
    naive=(http_c+ws_c)/max(elapsed,1)*86400
    methods=dict(collections.Counter(r.get("method") for r in http))
    st=dict(collections.Counter(str(r.get("status")) for r in http))
    line=f"t={int(elapsed):3d}s http={http_c}c/{len(http)} {methods} st={st} ws={sum(r.get('bytes') or 0 for r in ws)}B/{sum(1 for r in ws if r.get('method')=='wssOpen')}open/{ws_c}c naive={naive:.0f}/day 429s={st.get('429',0)}"
    print(line, flush=True)
    with OUT.open("a", encoding="utf-8") as fh:
        fh.write(line+"\n")
    if elapsed>=DURATION:
        over = naive>DAILY_HARD_CAP
        with OUT.open("a", encoding="utf-8") as fh:
            fh.write(f"DONE over_cap={over} naive={naive:.0f}\n")
        print("DONE", flush=True)
        break
    time.sleep(min(SAMPLE, max(1, DURATION-elapsed)))
