import { NextResponse } from 'next/server';
import { z } from 'zod';
import { isAuthenticated } from '@/lib/auth';
import { getConfiguredGoogleSheetUrl } from '@/lib/google-sheet';
import { normalizeAndValidateUrl } from '@/lib/jina';
import { getSupabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

const createSourceSchema = z.object({
  name: z.string().trim().min(1, 'Company / source name is required').max(100),
  url: z.string().trim().min(5, 'Career page URL is required').max(500),
});

export async function GET() {
  try {
    if (!(await isAuthenticated())) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from('sources')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      console.error('[api/sources GET] Supabase error:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({
      sources: data ?? [],
      sheetUrl: getConfiguredGoogleSheetUrl(),
    });
  } catch (error) {
    console.error('[api/sources GET] Error:', error);
    return NextResponse.json(
      { error: 'Failed to load sources.' },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    if (!(await isAuthenticated())) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json().catch(() => null);
    const parsed = createSourceSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message || 'Invalid source data.' },
        { status: 400 },
      );
    }

    let normalizedUrl: string;
    try {
      normalizedUrl = normalizeAndValidateUrl(parsed.data.url);
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : 'Invalid URL.' },
        { status: 400 },
      );
    }

    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from('sources')
      .insert({
        name: parsed.data.name,
        url: normalizedUrl,
        is_active: true,
      })
      .select('*')
      .single();

    if (error) {
      if (error.code === '23505') {
        return NextResponse.json(
          { error: 'This career page URL is already in your sources.' },
          { status: 409 },
        );
      }
      console.error('[api/sources POST] Supabase error:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ source: data }, { status: 201 });
  } catch (error) {
    console.error('[api/sources POST] Error:', error);
    return NextResponse.json(
      { error: 'Failed to add source.' },
      { status: 500 },
    );
  }
}
