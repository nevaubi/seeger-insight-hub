import { Link, useRouterState } from '@tanstack/react-router';
import { LayoutDashboard, FileText, Search, CalendarDays, Users, Scale } from 'lucide-react';
import type { ReactNode } from 'react';
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

  return (
    <div className="min-h-screen flex bg-background text-foreground">
      <aside className="w-64 shrink-0 bg-sidebar text-sidebar-foreground flex flex-col border-r border-sidebar-border">
        <div className="px-6 py-7 border-b border-sidebar-border">
          <div className="flex items-start gap-3">
            <Scale className="h-7 w-7 text-sidebar-foreground mt-0.5" strokeWidth={1.25} />
            <div>
              <div className="font-serif text-[26px] leading-none font-medium tracking-tight text-white">MDL 3140</div>
              <div className="mt-1.5 text-[10px] uppercase tracking-[0.18em] text-sidebar-foreground/70 font-sans font-medium">
                Command Center
              </div>
            </div>
          </div>
          <p className="mt-4 text-[12px] leading-snug text-sidebar-foreground/70 font-serif italic">
            In re: Depo-Provera Products Liability Litigation
          </p>
        </div>

        <nav className="flex-1 px-3 py-5 space-y-0.5">
          {NAV.map((item) => {
            const active = item.exact ? pathname === item.to : pathname.startsWith(item.to);
            const Icon = item.icon;
            return (
              <Link
                key={item.to}
                to={item.to}
                className={cn(
                  'group relative flex items-center gap-3 rounded-sm pl-4 pr-3 py-2.5 text-[11px] uppercase tracking-[0.09em] font-medium transition-colors',
                  active
                    ? 'bg-sidebar-accent text-white before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-[2px] before:bg-sidebar-primary before:rounded-r'
                    : 'text-sidebar-foreground/75 hover:bg-sidebar-accent/60 hover:text-white',
                )}
              >
                <Icon className="h-[15px] w-[15px]" strokeWidth={1.5} />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="px-6 py-5 border-t border-sidebar-border text-[10.5px] text-sidebar-foreground/60 leading-relaxed font-sans">
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
    <div className="border-b border-border bg-card px-8 py-8">
      <div className="flex items-start justify-between gap-6">
        <div>
          <h1 className="font-serif text-[32px] leading-[1.15] font-medium tracking-[-0.01em] text-foreground">{title}</h1>
          {description && (
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground max-w-2xl">{description}</p>
          )}
        </div>
        {children}
      </div>
    </div>
  );
}
