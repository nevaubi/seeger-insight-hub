import { createFileRoute, Outlet, redirect } from '@tanstack/react-router';
import { supabase } from '@/integrations/supabase/client';

function PendingShell() {
  return (
    <div className="min-h-screen bg-background">
      <div className="flex h-14 items-center border-b border-border/60 px-6">
        <div className="h-4 w-32 animate-pulse rounded bg-muted" />
      </div>
      <div className="p-6 space-y-3">
        <div className="h-4 w-48 animate-pulse rounded bg-muted" />
        <div className="h-4 w-72 animate-pulse rounded bg-muted/70" />
        <div className="h-4 w-64 animate-pulse rounded bg-muted/60" />
      </div>
    </div>
  );
}

export const Route = createFileRoute('/_authenticated')({
  ssr: false,
  beforeLoad: async ({ location }) => {
    const { data } = await supabase.auth.getSession();
    if (!data.session) {
      throw redirect({ to: '/auth', search: { redirect: location.href } });
    }
    return { user: data.session.user };
  },
  pendingComponent: PendingShell,
  component: () => <Outlet />,
});
