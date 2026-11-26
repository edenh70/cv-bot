import { NextResponse } from 'next/server';
import { isAuthenticated } from '@/lib/auth';
import { CvValidationError, validateAndRenderCv } from '@/lib/cv-validator';
import { patchDocxWithTailoredCv } from '@/lib/docx-template';
import { getActiveMasterCv } from '@/lib/master-cv-store';
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

    const { searchParams } = new URL(request.url);
    const format = searchParams.get('format');
    const safeCompany = sanitizeFilenameSegment(job.company);

    if (format === 'docx') {
      const { template, profile } = await getActiveMasterCv();
      if (!profile?.original_file_base64) {
        return NextResponse.json(
          {
            error:
              'Upload a .docx Master CV first to download in exact Word format.',
          },
          { status: 400 },
        );
      }

      const originalBuffer = Buffer.from(
        profile.original_file_base64,
        'base64',
      );
      const patchedDocx = await patchDocxWithTailoredCv(
        originalBuffer,
        template,
        job.tailored_cv_json as TailoredCV,
      );

      return new Response(new Uint8Array(patchedDocx), {
        status: 200,
        headers: {
          'Content-Type':
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'Content-Disposition': `attachment; filename="Eden_Hadad_CV_${safeCompany}.docx"`,
          'Cache-Control': 'private, no-store',
        },
      });
    }

    const storedCv = job.tailored_cv_json as TailoredCV;
    let cvToRender = storedCv;
    if (!storedCv.layout) {
      const { template } = await getActiveMasterCv();
      if (template.layout) {
        cvToRender = { ...storedCv, layout: template.layout };
      }
    }

    const { pdfBuffer } = await validateAndRenderCv(cvToRender, undefined, {
      preserveUploadedShape: true,
    });
    const filename = `Eden_Hadad_CV_${safeCompany}.pdf`;
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
    const message =
      error instanceof CvValidationError
        ? error.message
        : 'Failed to generate CV file.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
