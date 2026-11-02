import { createContext, useCallback, useContext, useEffect, useState } from 'react';

/**
 * Theme (plan 07): system | dark | light, persisted to localStorage and applied
 * as `data-theme` on <html>. index.html runs the same resolution pre-paint so
 * the first frame already carries the right palette; this provider keeps it in
 * sync afterwards (including live OS changes while the choice is "system").
 */
export type ThemeChoice = 'system' | 'dark' | 'light';
export type ResolvedTheme = 'dark' | 'light';

const STORAGE_KEY = 'zcode-theme';
const ORDER: ThemeChoice[] = ['system', 'dark', 'light'];

function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function resolve(choice: ThemeChoice): ResolvedTheme {
  if (choice === 'dark') return 'dark';
  if (choice === 'light') return 'light';
  return systemPrefersDark() ? 'dark' : 'light';
}

function storedChoice(): ThemeChoice {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === 'dark' || raw === 'light' || raw === 'system' ? raw : 'system';
  } catch {
    return 'system';
  }
}

interface ThemeContextValue {
  choice: ThemeChoice;
  resolved: ResolvedTheme;
  setChoice: (choice: ThemeChoice) => void;
  /** Cycles system → dark → light (the header's single toggle). */
  cycle: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [choice, setChoiceState] = useState<ThemeChoice>(storedChoice);
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolve(storedChoice()));

  const apply = useCallback((next: ThemeChoice) => {
    const theme = resolve(next);
    document.documentElement.dataset.theme = theme;
    setResolved(theme);
  }, []);

  const setChoice = useCallback(
    (next: ThemeChoice) => {
      setChoiceState(next);
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch {
        /* private mode: the choice still applies for this session */
      }
      apply(next);
    },
    [apply],
  );

  const cycle = useCallback(() => {
    setChoice(ORDER[(ORDER.indexOf(choice) + 1) % ORDER.length]!);
  }, [choice, setChoice]);

  useEffect(() => {
    apply(choice);
    if (choice !== 'system') return;
    // "System" follows the OS live, without a reload.
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => apply('system');
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [choice, apply]);

  return (
    <ThemeContext.Provider value={{ choice, resolved, setChoice, cycle }}>{children}</ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside ThemeProvider');
  return ctx;
}
