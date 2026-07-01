import { Link, useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import {
  LayoutDashboard,
  FileText,
  Search,
  Mic,
  CalendarDays,
  Users,
  PenLine,
  Table2,
  BookOpen,
  PanelLeftClose,
  PanelLeftOpen,
  ChevronsUpDown,
  Check,
  LogOut,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { useMatter } from '@/lib/matter-context';
import { supabase } from '@/integrations/supabase/client';
import logoUrl from '@/assets/seeger-weiss-logo-white.png';

import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';

type NavItem = { to: string; label: string; icon: typeof LayoutDashboard; exact?: boolean };
type NavSection = { label: string; items: NavItem[] };

const NAV_SECTIONS: NavSection[] = [
  {
    label: 'Workspace',
    items: [{ to: '/', label: 'Dashboard', icon: LayoutDashboard, exact: true }],
  },
  {
    label: 'Intelligence',
    items: [
      { to: '/orders', label: 'Orders', icon: FileText },
      { to: '/search', label: 'Ask the Record', icon: Search },
    ],
  },
  {
    label: 'Case',
    items: [] as { to: string; label: string; icon: any }[],
  },

  {
    label: 'Work Product',
    items: [
      { to: '/draft', label: 'Drafting', icon: PenLine },
      { to: '/review', label: 'Tabular Review', icon: Table2 },
      { to: '/depositions', label: 'Depositions', icon: Mic },
    ],
  },
];

function MatterSwitcher({ collapsed }: { collapsed: boolean }) {
  const { matters, currentMatter, setMatter } = useMatter();

  if (collapsed) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="mt-3 w-full inline-flex items-center justify-between gap-2 rounded-sm border border-sidebar-border/60 bg-sidebar-accent/30 hover:bg-sidebar-accent/60 px-2.5 py-1.5 text-left text-[11px] font-sans text-sidebar-foreground/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-primary/60 transition-colors"
        aria-label="Switch matter"
      >
        <span className="truncate font-medium text-white">{currentMatter.short_name}</span>
        <ChevronsUpDown className="h-3.5 w-3.5 text-sidebar-foreground/60 shrink-0" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
          Matter
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {matters.map((m) => {
          const active = m.slug === currentMatter.slug;
          return (
            <DropdownMenuItem
              key={m.slug}
              onSelect={() => setMatter(m.slug)}
              className="flex items-start gap-2 py-2"
            >
              <Check
                className={cn('h-3.5 w-3.5 mt-0.5 shrink-0', active ? 'opacity-100' : 'opacity-0')}
              />
              <div className="min-w-0">
                <div className="text-sm font-medium leading-tight">{m.short_name}</div>
                <div className="text-[11px] text-muted-foreground leading-tight mt-0.5">
                  MDL {m.mdl_number} · {m.court}
                </div>
              </div>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const { currentMatter } = useMatter();
  const overline = `MDL ${currentMatter.mdl_number} · Command Center`;

  return (
    <div className="min-h-screen flex bg-background text-foreground">
      <aside
        className={cn(
          'shrink-0 bg-sidebar text-sidebar-foreground flex flex-col border-r border-sidebar-border',
          'sticky top-0 h-screen overflow-hidden',
          'motion-safe:transition-[width] motion-safe:duration-300',
          collapsed ? 'w-11' : 'w-44',
        )}
        style={{ transitionTimingFunction: 'var(--ease-out-soft, cubic-bezier(0.22, 1, 0.36, 1))' }}
      >
        {/* Brand block */}
        <div
          className={cn(
            'border-b border-sidebar-border shrink-0',
            collapsed ? 'px-1.5 py-4 flex justify-center' : 'px-3 py-4',
          )}
        >
          {collapsed ? (
            <img
              src={logoUrl}
              alt="Seeger Weiss"
              className="h-10 w-auto brightness-0 invert opacity-95"
            />
          ) : (
            <>
              <img
                src={logoUrl}
                alt="Seeger Weiss LLP"
                className="h-16 w-auto brightness-0 invert opacity-95"
              />
              <div className="mt-2 text-[9px] uppercase tracking-[0.16em] text-sidebar-foreground/55 font-sans font-medium">
                {overline}
              </div>
              <MatterSwitcher collapsed={collapsed} />
            </>
          )}
        </div>

        {/* Nav */}
        <nav className={cn('flex-1 min-h-0 overflow-y-auto py-2', collapsed ? 'px-1' : 'px-1.5')}>
          {NAV_SECTIONS.filter((s) => s.items.length > 0).map((section, sIdx) => (
            <div key={section.label} className={sIdx === 0 ? '' : 'mt-3'}>
              {!collapsed && (
                <div className="px-2.5 pt-1 pb-1 text-[9px] uppercase tracking-[0.18em] text-sidebar-foreground/40 font-sans font-medium">
                  {section.label}
                </div>
              )}
              <div className="space-y-px">
                {section.items.map((item) => {
                  const Icon = item.icon;
                  return (
                    <Link
                      key={item.to}
                      to={item.to}
                      preload="intent"
                      activeOptions={{ exact: !!item.exact }}
                      title={collapsed ? item.label : undefined}
                      aria-label={item.label}
                      className={cn(
                        'group flex items-center rounded-sm h-8 font-sans text-[11.5px] font-medium transition-colors',
                        'border-l-2 border-transparent',
                        'text-sidebar-foreground/75 hover:bg-sidebar-accent/60 hover:text-white',
                        'data-[status=active]:bg-sidebar-accent data-[status=active]:text-white data-[status=active]:border-sidebar-primary',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-primary/60',
                        collapsed ? 'justify-center px-0' : 'gap-2.5 pl-[10px] pr-2',
                      )}
                    >
                      <Icon className="h-[14px] w-[14px] shrink-0" strokeWidth={1.75} />
                      {!collapsed && <span className="truncate">{item.label}</span>}
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>


        {/* Footer: sign out + toggle */}
        <div className="border-t border-sidebar-border shrink-0">
          <SignOutRow collapsed={collapsed} />
          <div className={cn('flex', collapsed ? 'justify-center py-2' : 'justify-end px-2 py-2')}>
            <button
              type="button"
              onClick={() => setCollapsed((c) => !c)}
              title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              aria-expanded={!collapsed}
              className="inline-flex h-7 w-7 items-center justify-center rounded-sm text-sidebar-foreground/60 hover:text-white hover:bg-sidebar-accent/60 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-primary/60"
            >
              {collapsed ? (
                <PanelLeftOpen className="h-3.5 w-3.5" strokeWidth={1.75} />
              ) : (
                <PanelLeftClose className="h-3.5 w-3.5" strokeWidth={1.75} />
              )}
            </button>
          </div>
        </div>
      </aside>

      <main className="flex-1 min-w-0">{children}</main>
    </div>
  );
}

function SignOutRow({ collapsed }: { collapsed: boolean }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);

  async function handleSignOut() {
    if (busy) return;
    setBusy(true);
    await queryClient.cancelQueries();
    queryClient.clear();
    await supabase.auth.signOut();
    navigate({ to: '/auth', replace: true });
  }

  return (
    <div className={cn('flex', collapsed ? 'justify-center py-2' : 'px-2 py-2')}>
      <button
        type="button"
        onClick={handleSignOut}
        disabled={busy}
        title="Sign out"
        aria-label="Sign out"
        className={cn(
          'inline-flex items-center rounded-sm font-sans text-[11.5px] font-medium text-sidebar-foreground/70 hover:text-white hover:bg-sidebar-accent/60 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-primary/60 disabled:opacity-50',
          collapsed ? 'h-7 w-7 justify-center' : 'w-full h-8 gap-2 px-2.5',
        )}
      >
        <LogOut className="h-[14px] w-[14px] shrink-0" strokeWidth={1.75} />
        {!collapsed && <span>Sign out</span>}
      </button>
    </div>
  );
}


export function PageHeader({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className="border-b border-border bg-card px-8 py-8">
      <div className="flex items-start justify-between gap-6">
        <div>
          <h1 className="font-serif text-[32px] leading-[1.15] font-semibold tracking-[-0.015em] text-foreground">
            {title}
          </h1>
          {description && (
            <p className="mt-2 font-sans text-sm leading-relaxed text-muted-foreground max-w-2xl">
              {description}
            </p>
          )}
        </div>
        {children}
      </div>
    </div>
  );
}
