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
  ChevronsUpDown,
  Check,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { useMatter } from '@/lib/matter-context';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';

const NAV: { to: string; label: string; icon: typeof LayoutDashboard; exact?: boolean }[] = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, exact: true },
  { to: '/orders', label: 'Orders Intelligence', icon: FileText },
  { to: '/search', label: 'Ask the Record', icon: Search },
  { to: '/deadlines', label: 'Deadlines & Calendar', icon: CalendarDays },
  { to: '/roster', label: 'Roster & Key Players', icon: Users },
];

function MatterSwitcher({ collapsed }: { collapsed: boolean }) {
  const { matters, currentMatter, setMatter } = useMatter();

  if (collapsed) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="mt-4 w-full inline-flex items-center justify-between gap-2 rounded-sm border border-sidebar-border/60 bg-sidebar-accent/30 hover:bg-sidebar-accent/60 px-2.5 py-1.5 text-left text-[11px] font-sans text-sidebar-foreground/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-primary/60 transition-colors"
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
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [collapsed, setCollapsed] = useState(false);
  const { currentMatter } = useMatter();
  const cfg = currentMatter.config ?? {};
  const brandTitle = cfg.command_center_title ?? `MDL ${currentMatter.mdl_number}`;
  const subtitle = cfg.subtitle ?? currentMatter.name;
  const courtLines = cfg.court_lines ?? [];

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
                <div className="min-w-0">
                  <div className="font-serif text-[26px] leading-none font-semibold tracking-tight text-white truncate">
                    {brandTitle}
                  </div>
                  <div className="mt-1.5 text-[10px] uppercase tracking-[0.18em] text-sidebar-foreground/70 font-sans font-medium">
                    Command Center
                  </div>
                </div>
              </div>
              <p className="mt-4 text-[12px] leading-snug text-sidebar-foreground/70 font-serif italic">
                {subtitle}
              </p>
              <MatterSwitcher collapsed={collapsed} />
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
          {!collapsed && courtLines.length > 0 && (
            <div className="px-6 pt-5 pb-3 text-[10.5px] text-sidebar-foreground/60 leading-relaxed font-sans">
              {courtLines.map((line, i) => (
                <div key={i} className={i === 2 ? 'mt-1' : undefined}>
                  {line}
                </div>
              ))}
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
