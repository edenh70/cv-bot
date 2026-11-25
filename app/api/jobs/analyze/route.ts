import { NextResponse } from 'next/server';
import { z } from 'zod';
import { isAuthenticated } from '@/lib/auth';
import { analyzeSingleJobUrl } from '@/lib/pipeline';

export const maxDuration = 60;

const analyzeSchema = z.object({
  url: z.string().trim().min(5, 'Please paste a valid job posting URL.'),
});

export async function POST(request: Request) {
  try {
    if (!(await isAuthenticated())) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json().catch(() => null);
    const parsed = analyzeSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message || 'Invalid URL.' },
        { status: 400 },
      );
    }

    const result = await analyzeSingleJobUrl(parsed.data.url);

    return NextResponse.json(result, {
      status: result.alreadyExisted ? 200 : 201,
    });
  } catch (error) {
    console.error('[api/jobs/analyze POST] Error:', error);
    const message =
      error instanceof Error ? error.message : 'Failed to analyze job URL.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
