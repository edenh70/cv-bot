import { NextResponse } from 'next/server';
import { z } from 'zod';
import { isAuthenticated } from '@/lib/auth';
import { getSupabaseAdmin } from '@/lib/supabase';

const updateJobSchema = z.object({
  status: z.enum(['pending_review', 'applied', 'archived']),
});

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    if (!(await isAuthenticated())) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await context.params;
    const body = await request.json().catch(() => null);
    const parsed = updateJobSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid status payload.' },
        { status: 400 },
      );
    }

    const updates: { status: string; applied_at: string | null } = {
      status: parsed.data.status,
      applied_at:
        parsed.data.status === 'applied' ? new Date().toISOString() : null,
    };

    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from('jobs')
      .update(updates)
      .eq('id', id)
      .select('*')
      .single();

    if (error) {
      console.error('[api/jobs/[id] PATCH] Supabase error:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    if (!data) {
      return NextResponse.json({ error: 'Job not found.' }, { status: 404 });
    }

    return NextResponse.json({ job: data });
  } catch (error) {
    console.error('[api/jobs/[id] PATCH] Error:', error);
    return NextResponse.json(
      { error: 'Failed to update job.' },
      { status: 500 },
    );
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    if (!(await isAuthenticated())) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await context.params;
    const supabase = getSupabaseAdmin();
    const { error } = await supabase.from('jobs').delete().eq('id', id);

    if (error) {
      console.error('[api/jobs/[id] DELETE] Supabase error:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('[api/jobs/[id] DELETE] Error:', error);
    return NextResponse.json(
      { error: 'Failed to delete job.' },
      { status: 500 },
    );
  }
}
