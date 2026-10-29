import { useEffect, useState } from 'react';
import { api } from '../api';

export function AuditPage({ onBack }: { onBack: () => void }) {
  const [events, setEvents] = useState<Array<Record<string, unknown>>>([]);
  const [rejections, setRejections] = useState<Array<Record<string, unknown>>>([]);
  const [recommendations, setRecommendations] = useState<Array<Record<string, unknown>>>([]);
  const [cases, setCases] = useState<Array<Record<string, unknown>>>([]);

  useEffect(() => {
    void api.audit().then((r) => setEvents(r.events));
    void api.rejections().then((r) => setRejections(r.rejections));
    void api.recommendation().then((r) => setRecommendations(r.recommendations));
    void api.reconciliation().then((r) => setCases(r.cases));
  }, []);

  return (
    <div className="pb-24">
      <div className="flex items-center justify-between pt-5 pb-3">
        <h1 className="text-[18px] font-bold">Audit</h1>
        <button onClick={onBack} className="label !text-[10px] underline">
          ← dashboard
        </button>
      </div>

      <section className="card p-5 mb-4">
        <p className="label">RECOMMENDATIONS</p>
        {recommendations.length === 0 && <p className="text-[12px] text-[#7d78a0] mt-2">none yet</p>}
        <ul className="mt-2 space-y-3">
          {recommendations.slice(0, 8).map((r: Record<string, unknown>) => {
            const candidates =
              (r.candidates as Array<{
                rank: number;
                candidateId: string;
                confidence: number;
                thesis: string;
              }>) ?? [];
            return (
              <li key={String(r.recommendationId)} className="border-b border-white/70 pb-2 text-[12px]">
                <p className="font-mono text-[10px] text-[#7d78a0]">
                  {String(r.status).toUpperCase()} · {String(r.recommendationId).slice(0, 13)}… · expires{' '}
                  {new Date(String(r.expiresAt)).toLocaleTimeString()} ·{' '}
                  {r.modelLabel ? String(r.modelLabel) : 'model —'}
                </p>
                {candidates.map((c) => (
                  <p key={c.rank} className="mt-0.5">
                    <strong>
                      #{c.rank} {c.candidateId}
                    </strong>{' '}
                    · confidence {c.confidence} — {c.thesis.slice(0, 90)}
                  </p>
                ))}
                {r.validationError ? <p className="text-rose-600 mt-1">{String(r.validationError)}</p> : null}
              </li>
            );
          })}
        </ul>
      </section>

      <section className="card p-5 mb-4">
        <p className="label">RISK REJECTIONS</p>
        {rejections.length === 0 && <p className="text-[12px] text-[#7d78a0] mt-2">none</p>}
        <ul className="mt-2 text-[11.5px] space-y-1 max-h-56 overflow-auto">
          {rejections.slice(0, 40).map((r: Record<string, unknown>, i: number) => (
            <li key={i} className="font-mono">
              {String(r.createdAt).slice(11, 19)} {String(r.rule)} value={String(r.actualValue)} limit=
              {String(r.limitValue)}
            </li>
          ))}
        </ul>
      </section>

      <section className="card p-5 mb-4">
        <p className="label">RECONCILIATION CASES</p>
        {cases.length === 0 && <p className="text-[12px] text-[#7d78a0] mt-2">none open</p>}
        <ul className="mt-2 text-[12px] space-y-1">
          {cases.map((c, i) => (
            <li key={i} className="text-fuchsia-700">
              {String(c.kind)} · {String(c.detail ?? '')}
            </li>
          ))}
        </ul>
      </section>

      <section className="card p-5">
        <p className="label">EVENT LOG</p>
        <ul className="mt-2 text-[11.5px] space-y-1 max-h-80 overflow-auto">
          {events.slice(0, 60).map((e: Record<string, unknown>, i: number) => (
            <li key={i} className="border-b border-white/60 pb-1">
              <span className="font-mono text-[10px] text-[#7d78a0]">
                {String(e.createdAt).slice(11, 19)} [{String(e.category)}]
              </span>{' '}
              {String(e.message)}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
