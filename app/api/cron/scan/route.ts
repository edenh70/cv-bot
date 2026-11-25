import { NextResponse } from 'next/server';
import { isAuthenticated, isCronAuthorized } from '@/lib/auth';
import { runDailyScan } from '@/lib/pipeline';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

async function handleScan(request: Request) {
  try {
    const authorized =
      isCronAuthorized(request) || (await isAuthenticated());

    if (!authorized) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const summary = await runDailyScan(3);
    return NextResponse.json(summary);
  } catch (error) {
    console.error('[api/cron/scan] Error:', error);
    const message =
      error instanceof Error ? error.message : 'Daily scan failed.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function GET(request: Request) {
  return handleScan(request);
}

export async function POST(request: Request) {
  return handleScan(request);
}
