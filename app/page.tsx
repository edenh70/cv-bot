import { isAuthenticated } from '@/lib/auth';
import { DashboardShell } from '@/components/DashboardShell';
import { LoginGate } from '@/components/LoginGate';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const authenticated = await isAuthenticated();

  if (!authenticated) {
    return <LoginGate />;
  }

  return <DashboardShell />;
}
