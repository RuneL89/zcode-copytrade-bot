import { useEffect, useState } from 'react';

/**
 * Word-confirmation dialog for dangerous control actions (emergency stop,
 * close-all). Escape and backdrop-click cancel; the action fires only when
 * the typed word matches.
 */
export function ConfirmDialog({
  title,
  dangerLabel,
  body,
  requiredWord,
  confirmLabel,
  busy,
  onConfirm,
  onCancel,
}: {
  title: string;
  dangerLabel: string;
  body: string;
  requiredWord: string;
  confirmLabel: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [word, setWord] = useState('');
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4 anim-scrim"
      style={{ background: 'rgba(4, 5, 8, 0.7)', backdropFilter: 'blur(5px)' }}
      role="dialog"
      aria-modal="true"
      aria-label={`confirm ${title}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="card !bg-glassstrong p-5 w-full max-w-[400px] anim-raise">
        <p className="tag !text-neg">{dangerLabel}</p>
        <p className="text-[15px] font-bold mt-1">{title}</p>
        <p className="text-[12px] text-muted mt-1.5">{body}</p>
        <input
          value={word}
          onChange={(e) => setWord(e.target.value)}
          placeholder={`type ${requiredWord}`}
          className="w-full mt-3 rounded-[12px] border border-glassborder bg-inset px-3 py-2 text-[13px] mono text-ink placeholder:text-faint"
          autoFocus
        />
        <div className="flex gap-2 mt-4">
          <button
            onClick={onCancel}
            className="flex-1 rounded-[12px] border border-glassborder bg-inset text-[12px] font-semibold py-2 text-ink cursor-pointer"
          >
            Cancel
          </button>
          <button
            disabled={busy || word.trim() !== requiredWord}
            onClick={onConfirm}
            className="flex-1 rounded-[12px] bg-negdim border border-negborder text-neg mono text-[12px] font-bold py-2 disabled:opacity-40 cursor-pointer"
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
