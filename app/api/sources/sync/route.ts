import { NextResponse } from 'next/server';
import { isAuthenticated, isCronAuthorized } from '@/lib/auth';
import { syncSourcesFromGoogleSheet } from '@/lib/google-sheet';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const authorized =
      (await isAuthenticated()) || isCronAuthorized(request);

    if (!authorized) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const result = await syncSourcesFromGoogleSheet();
    return NextResponse.json(result);
  } catch (error) {
    console.error('[api/sources/sync POST] Error:', error);
    const message =
      error instanceof Error
        ? error.message
        : 'Failed to sync sources from Google Sheet.';
    const status = message.includes('Google Sheet is private') ? 400 : 502;
    return NextResponse.json({ error: message }, { status });
  }
}
