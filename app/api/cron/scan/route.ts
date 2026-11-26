import { NextResponse } from 'next/server';
import { z } from 'zod';
import { isAuthenticated, isCronAuthorized } from '@/lib/auth';
import { runDailyScan } from '@/lib/pipeline';

export const dynamic = 'force-dynamic';
export const maxDuration = 180;

const scanRequestSchema = z.object({
  prompt: z.string().trim().max(400).optional(),
  maxJobs: z.coerce.number().int().min(1).max(5).optional(),
  maxSources: z.coerce.number().int().min(1).max(15).optional(),
});

export async function GET(request: Request) {
  try {
    const authorized =
      isCronAuthorized(request) || (await isAuthenticated());

    if (!authorized) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const summary = await runDailyScan({
      maxNewJobs: 3,
      maxSources: 8,
      maxPagesPerSource: 3,
    });
    return NextResponse.json(summary);
  } catch (error) {
    console.error('[api/cron/scan GET] Error:', error);
    const message =
      error instanceof Error ? error.message : 'Daily scan failed.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const authorized =
      (await isAuthenticated()) || isCronAuthorized(request);

    if (!authorized) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const rawBody = await request.json().catch(() => ({}));
    const parsed = scanRequestSchema.safeParse(rawBody ?? {});
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message || 'Invalid scan parameters.' },
        { status: 400 },
      );
    }

    const summary = await runDailyScan({
      customPrompt: parsed.data.prompt || undefined,
      maxNewJobs: parsed.data.maxJobs ?? 3,
      maxSources: parsed.data.maxSources ?? 8,
      maxPagesPerSource: 3,
    });
    return NextResponse.json(summary);
  } catch (error) {
    console.error('[api/cron/scan POST] Error:', error);
    const message =
      error instanceof Error ? error.message : 'Scan failed.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
