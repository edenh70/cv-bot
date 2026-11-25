import { NextResponse } from 'next/server';
import { z } from 'zod';
import { isAuthenticated } from '@/lib/auth';
import { normalizeAndValidateUrl } from '@/lib/jina';
import { getSupabaseAdmin } from '@/lib/supabase';

const updateSourceSchema = z.object({
  is_active: z.boolean().optional(),
  name: z.string().trim().min(1).max(100).optional(),
  url: z.string().trim().min(5).max(500).optional(),
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
    const parsed = updateSourceSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid source update payload.' },
        { status: 400 },
      );
    }

    const updates: Record<string, unknown> = {};
    if (typeof parsed.data.is_active === 'boolean') {
      updates.is_active = parsed.data.is_active;
    }
    if (parsed.data.name !== undefined) {
      updates.name = parsed.data.name;
    }
    if (parsed.data.url !== undefined) {
      updates.url = normalizeAndValidateUrl(parsed.data.url);
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json(
        { error: 'No fields provided to update.' },
        { status: 400 },
      );
    }

    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from('sources')
      .update(updates)
      .eq('id', id)
      .select('*')
      .single();

    if (error) {
      console.error('[api/sources/[id] PATCH] Supabase error:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    if (!data) {
      return NextResponse.json({ error: 'Source not found.' }, { status: 404 });
    }

    return NextResponse.json({ source: data });
  } catch (error) {
    console.error('[api/sources/[id] PATCH] Error:', error);
    return NextResponse.json(
      { error: 'Failed to update source.' },
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
    const { error } = await supabase.from('sources').delete().eq('id', id);

    if (error) {
      console.error('[api/sources/[id] DELETE] Supabase error:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('[api/sources/[id] DELETE] Error:', error);
    return NextResponse.json(
      { error: 'Failed to delete source.' },
      { status: 500 },
    );
  }
}
