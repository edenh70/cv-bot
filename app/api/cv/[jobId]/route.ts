import { NextResponse } from 'next/server';
import { isAuthenticated } from '@/lib/auth';
import { renderCvPdfBuffer } from '@/lib/cv-pdf';
import { getSupabaseAdmin } from '@/lib/supabase';
import type { TailoredCV } from '@/lib/types';

export const dynamic = 'force-dynamic';

function sanitizeFilenameSegment(input: string): string {
  const cleaned = input
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned || 'Company';
}

export async function GET(
  request: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  try {
    if (!(await isAuthenticated())) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { jobId } = await context.params;
    const supabase = getSupabaseAdmin();

    const { data: job, error } = await supabase
      .from('jobs')
      .select('id, company, tailored_cv_json')
      .eq('id', jobId)
      .maybeSingle();

    if (error) {
      console.error('[api/cv/[jobId] GET] Supabase error:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    if (!job) {
      return NextResponse.json({ error: 'Job not found.' }, { status: 404 });
    }

    const pdfBuffer = await renderCvPdfBuffer(job.tailored_cv_json as TailoredCV);
    const safeCompany = sanitizeFilenameSegment(job.company);
    const filename = `Eden_Hadad_CV_${safeCompany}.pdf`;

    const { searchParams } = new URL(request.url);
    const isDownload = searchParams.get('download') === '1';
    const disposition = isDownload ? 'attachment' : 'inline';

    return new Response(new Uint8Array(pdfBuffer), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `${disposition}; filename="${filename}"`,
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (error) {
    console.error('[api/cv/[jobId] GET] Error:', error);
    return NextResponse.json(
      { error: 'Failed to generate CV PDF.' },
      { status: 500 },
    );
  }
}
