import { NextResponse } from 'next/server';
import { isAuthenticated } from '@/lib/auth';
import { getSupabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    if (!(await isAuthenticated())) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status');

    const supabase = getSupabaseAdmin();
    let query = supabase.from('jobs').select('*');

    if (
      status === 'pending_review' ||
      status === 'applied' ||
      status === 'archived'
    ) {
      query = query.eq('status', status);
    }

    if (status === 'applied') {
      query = query
        .order('applied_at', { ascending: false, nullsFirst: false })
        .order('created_at', { ascending: false });
    } else {
      query = query.order('created_at', { ascending: false });
    }

    const { data, error } = await query;

    if (error) {
      console.error('[api/jobs GET] Supabase error:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ jobs: data ?? [] });
  } catch (error) {
    console.error('[api/jobs GET] Error:', error);
    return NextResponse.json(
      { error: 'Failed to load jobs.' },
      { status: 500 },
    );
  }
}
