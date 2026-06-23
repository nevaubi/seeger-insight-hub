import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useRouterState } from '@tanstack/react-router';
import { supabase } from '@/lib/supabase';

export interface MatterConfig {
  command_center_title?: string;
  subtitle?: string;
  court_lines?: string[];
  examples_synth?: string[];
  examples_browse?: string[];
}

export interface Matter {
  id: string;
  slug: string;
  name: string;
  short_name: string;
  mdl_number: string;
  court: string;
  judge: string;
  master_case_id: string;
  is_default: boolean;
  sort_order: number;
  config: MatterConfig;
}

// Fallback matter so the UI still works if the matters table isn't readable
// (e.g. missing GRANT to anon). Mirrors the prior hard-coded Depo-Provera setup.
const FALLBACK_DEPO: Matter = {
  id: 'fallback-depo',
  slug: 'depo-provera',
  name: 'In re: Depo-Provera Products Liability Litigation',
  short_name: 'Depo-Provera',
  mdl_number: '3140',
  court: 'U.S. District Court, N.D. Fla., Pensacola Division',
  judge: 'M. Casey Rodgers',
  master_case_id: '4ea28a93-3e76-4b10-b6da-6794fef3c7c1',
  is_default: true,
  sort_order: 0,
  config: {
    command_center_title: 'MDL 3140',
    subtitle: 'In re: Depo-Provera Products Liability Litigation',
    court_lines: [
      'U.S. District Court',
      'N.D. Fla., Pensacola Division',
      'Judge M. Casey Rodgers',
      'Mag. Judge Hope T. Cannon',
    ],
    examples_synth: [
      'What must plaintiffs do to establish proof of Depo-Provera use, and by when?',
      "What does PTO 22A's Deficiency Exception require?",
      'What are the common-benefit assessment obligations?',
      'What is the Rule 702 / Daubert schedule?',
    ],
    examples_browse: [
      'threshold proof of use',
      'deposition protocol',
      'money from outside investors paying for the lawsuit',
      'common benefit',
    ],
  },
};

interface MatterContextValue {
  matters: Matter[];
  currentMatter: Matter;
  setMatter: (slug: string) => void;
  loading: boolean;
}

const MatterContext = createContext<MatterContextValue | null>(null);

function readSlugFromUrl(): string | null {
  if (typeof window === 'undefined') return null;
  const p = new URLSearchParams(window.location.search);
  return p.get('matter');
}

function writeSlugToUrl(slug: string) {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  if (url.searchParams.get('matter') === slug) return;
  url.searchParams.set('matter', slug);
  window.history.replaceState(window.history.state, '', url.toString());
}

export function MatterProvider({ children }: { children: ReactNode }) {
  const [matters, setMatters] = useState<Matter[]>([FALLBACK_DEPO]);
  const [loading, setLoading] = useState(true);
  const [slug, setSlug] = useState<string | null>(() => readSlugFromUrl());
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  // Load matters once
  useEffect(() => {
    let alive = true;
    (async () => {
      const { data, error } = await supabase
        .from('matters')
        .select('*')
        .order('sort_order', { ascending: true });
      if (!alive) return;
      if (!error && data && data.length > 0) {
        setMatters(data as Matter[]);
      }
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, []);

  const currentMatter = useMemo(() => {
    const wanted = slug ?? readSlugFromUrl();
    return (
      (wanted && matters.find((m) => m.slug === wanted)) ||
      matters.find((m) => m.is_default) ||
      matters[0] ||
      FALLBACK_DEPO
    );
  }, [matters, slug]);

  // Keep URL in sync with current matter, including after Link navigation
  useEffect(() => {
    writeSlugToUrl(currentMatter.slug);
  }, [currentMatter.slug, pathname]);

  const setMatter = useCallback((s: string) => {
    setSlug(s);
    writeSlugToUrl(s);
  }, []);

  return (
    <MatterContext.Provider value={{ matters, currentMatter, setMatter, loading }}>
      {children}
    </MatterContext.Provider>
  );
}

export function useMatter(): MatterContextValue {
  const ctx = useContext(MatterContext);
  if (!ctx) throw new Error('useMatter must be used within MatterProvider');
  return ctx;
}
