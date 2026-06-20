import { Link, useRouterState } from '@tanstack/react-router';
import { LayoutDashboard, FileText, Search, CalendarDays, Users, Scale } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

const NAV = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, exact: true },
  { to: '/orders', label: 'Orders Intelligence', icon: FileText },
  { to: '/search', label: 'Ask the Record', icon: Search },
  { to: '/deadlines', label: 'Deadlines & Calendar', icon: CalendarDays },
  { to: '/roster', label: 'Roster & Key Players', icon: Users },
] as const;

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  return (
    <div className="min-h-screen flex bg-background text-foreground">
      <aside className="w-64 shrink-0 bg-sidebar text-sidebar-foreground flex flex-col border-r border-sidebar-border">
        <div className="px-5 py-6 border-b border-sidebar-border">
          <div className="flex items-center gap-2.5">
            <Scale className="h-6 w-6 text-sidebar-primary" strokeWidth={1.5} />
            <div>
              <div className="font-serif text-base font-semibold leading-tight">MDL 3140</div>
              <div className="text-[11px] uppercase tracking-wider text-sidebar-foreground/60">
                Command Center
              </div>
            </div>
          </div>
          <p className="mt-3 text-xs leading-relaxed text-sidebar-foreground/70 font-serif italic">
            In re: Depo-Provera Products Liability Litigation
          </p>
        </div>

        <nav className="flex-1 px-3 py-4 space-y-0.5">
          {NAV.map((item) => {
            const active = item.exact ? pathname === item.to : pathname.startsWith(item.to);
            const Icon = item.icon;
            return (
              <Link
                key={item.to}
                to={item.to}
                className={cn(
                  'flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
                  active
                    ? 'bg-sidebar-primary text-sidebar-primary-foreground font-medium'
                    : 'text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
                )}
              >
                <Icon className="h-4 w-4" strokeWidth={1.75} />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="px-5 py-4 border-t border-sidebar-border text-[11px] text-sidebar-foreground/55 leading-relaxed">
          <div>U.S. District Court</div>
          <div>N.D. Fla., Pensacola Division</div>
          <div className="mt-1">Judge M. Casey Rodgers</div>
          <div>Mag. Judge Hope T. Cannon</div>
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
    <div className="border-b border-border bg-card/40 px-8 py-6">
      <div className="flex items-start justify-between gap-6">
        <div>
          <h1 className="font-serif text-3xl font-semibold text-foreground">{title}</h1>
          {description && (
            <p className="mt-1.5 text-sm text-muted-foreground max-w-2xl">{description}</p>
          )}
        </div>
        {children}
      </div>
    </div>
  );
}
