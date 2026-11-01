import type { ReactNode } from 'react';

/** Segmented tab strip used inside OPS and Settings. */
export function PageTabs<T extends string>({
  tabs,
  active,
  onChange,
  label,
}: {
  tabs: Array<{ id: T; label: string }>;
  active: T;
  onChange: (id: T) => void;
  label: string;
}) {
  return (
    <div role="tablist" aria-label={label} className="flex gap-1 mb-3.5 p-1 panel !rounded-full">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          type="button"
          aria-selected={active === t.id}
          onClick={() => onChange(t.id)}
          className={`flex-1 min-h-[36px] rounded-full text-[12px] font-semibold transition-colors cursor-pointer ${
            active === t.id ? 'bg-accentdim text-accent' : 'text-muted hover:text-ink'
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function TabPanel({ children }: { children: ReactNode }) {
  return <div role="tabpanel">{children}</div>;
}
