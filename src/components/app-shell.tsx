import { Link, useRouterState } from '@tanstack/react-router';
import {
  LayoutDashboard,
  FileText,
  Search,
  CalendarDays,
  Users,
  Scale,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

const NAV: { to: string; label: string; icon: typeof LayoutDashboard; exact?: boolean }[] = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, exact: true },
  { to: '/orders', label: 'Orders Intelligence', icon: FileText },
  { to: '/search', label: 'Ask the Record', icon: Search },
  { to: '/deadlines', label: 'Deadlines & Calendar', icon: CalendarDays },
  { to: '/roster', label: 'Roster & Key Players', icon: Users },
];

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="min-h-screen flex bg-background text-foreground">
      <aside
        className={cn(
          'shrink-0 bg-sidebar text-sidebar-foreground flex flex-col border-r border-sidebar-border',
          'motion-safe:transition-[width] motion-safe:duration-300',
          collapsed ? 'w-16' : 'w-64',
        )}
        style={{ transitionTimingFunction: 'var(--ease-out-soft, cubic-bezier(0.22, 1, 0.36, 1))' }}
      >
        {/* Brand block */}
        <div
          className={cn(
            'border-b border-sidebar-border',
            collapsed ? 'px-3 py-5 flex justify-center' : 'px-6 py-7',
          )}
        >
          {collapsed ? (
            <Scale className="h-6 w-6 text-sidebar-foreground" strokeWidth={1.25} />
          ) : (
            <>
              <div className="flex items-start gap-3">
                <Scale className="h-7 w-7 text-sidebar-foreground mt-0.5" strokeWidth={1.25} />
                <div>
                  <div className="font-serif text-[26px] leading-none font-semibold tracking-tight text-white">
                    MDL 3140
                  </div>
                  <div className="mt-1.5 text-[10px] uppercase tracking-[0.18em] text-sidebar-foreground/70 font-sans font-medium">
                    Command Center
                  </div>
                </div>
              </div>
              <p className="mt-4 text-[12px] leading-snug text-sidebar-foreground/70 font-serif italic">
                In re: Depo-Provera Products Liability Litigation
              </p>
            </>
          )}
        </div>

        {/* Nav */}
        <nav className={cn('flex-1 py-4 space-y-0.5', collapsed ? 'px-2' : 'px-3')}>
          {NAV.map((item) => {
            const active = item.exact ? pathname === item.to : pathname.startsWith(item.to);
            const Icon = item.icon;
            return (
              <Link
                key={item.to}
                to={item.to}
                title={collapsed ? item.label : undefined}
                aria-label={item.label}
                className={cn(
                  'group relative flex items-center rounded-sm h-10 font-sans text-[11px] uppercase tracking-[0.09em] font-medium transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-primary/60',
                  collapsed ? 'justify-center px-0' : 'gap-3 pl-4 pr-3',
                  active
                    ? 'bg-sidebar-accent text-white before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-[2px] before:bg-sidebar-primary before:rounded-r'
                    : 'text-sidebar-foreground/75 hover:bg-sidebar-accent/60 hover:text-white',
                )}
              >
                <Icon className="h-[16px] w-[16px] shrink-0" strokeWidth={1.5} />
                {!collapsed && <span className="truncate">{item.label}</span>}
              </Link>
            );
          })}
        </nav>

        {/* Footer: court info + toggle */}
        <div className="border-t border-sidebar-border">
          {!collapsed && (
            <div className="px-6 pt-5 pb-3 text-[10.5px] text-sidebar-foreground/60 leading-relaxed font-sans">
              <div>U.S. District Court</div>
              <div>N.D. Fla., Pensacola Division</div>
              <div className="mt-1">Judge M. Casey Rodgers</div>
              <div>Mag. Judge Hope T. Cannon</div>
            </div>
          )}
          <div className={cn('flex', collapsed ? 'justify-center py-3' : 'justify-end px-3 pb-3')}>
            <button
              type="button"
              onClick={() => setCollapsed((c) => !c)}
              title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              aria-expanded={!collapsed}
              className="inline-flex h-8 w-8 items-center justify-center rounded-sm text-sidebar-foreground/60 hover:text-white hover:bg-sidebar-accent/60 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-primary/60"
            >
              {collapsed ? (
                <PanelLeftOpen className="h-4 w-4" strokeWidth={1.5} />
              ) : (
                <PanelLeftClose className="h-4 w-4" strokeWidth={1.5} />
              )}
            </button>
          </div>
        </div>
      </aside>

      <main className="flex-1 min-w-0">{children}</main>
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
