import { NextResponse } from 'next/server';
import { isAuthenticated } from '@/lib/auth';
import { CvValidationError, validatePdfBinary } from '@/lib/cv-validator';
import {
  patchDocxWithReplacements,
  patchDocxWithTailoredCv,
  validateDocxBinary,
} from '@/lib/docx-template';
import {
  convertDocxToPdf,
  PdfConverterNotConfiguredError,
} from '@/lib/docx-to-pdf';
import { getActiveMasterCv } from '@/lib/master-cv-store';
import { getSupabaseAdmin } from '@/lib/supabase';
import type { TailoredCV, TailoringDiffMap } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

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
      .select(
        'id, company, status, validation_error, tailored_cv_json, tailoring_diffs_json, tailored_docx_base64, tailored_pdf_base64',
      )
      .eq('id', jobId)
      .maybeSingle();

    if (error) {
      console.error('[api/cv/[jobId] GET] Supabase error:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    if (!job) {
      return NextResponse.json({ error: 'Job not found.' }, { status: 404 });
    }

    // Hard block downloads if the job failed 1-page validation
    if (job.status === 'failed_validation') {
      return NextResponse.json(
        {
          error:
            job.validation_error ||
            'CV failed 1-page validation (Exceeded 1 page) and is blocked from download.',
        },
        { status: 422 },
      );
    }

    const { searchParams } = new URL(request.url);
    const format = searchParams.get('format');
    const inlineParam = searchParams.get('inline');
    const downloadParam = searchParams.get('download');
    const safeCompany = sanitizeFilenameSegment(job.company);

    const resolvePatchedDocx = async (): Promise<Buffer> => {
      if (job.tailored_docx_base64) {
        const cachedDocx = Buffer.from(job.tailored_docx_base64, 'base64');
        const check = await validateDocxBinary(cachedDocx);
        if (check.valid) return cachedDocx;
      }

      const { template, profile } = await getActiveMasterCv();
      if (!profile?.original_file_base64) {
        throw new Error(
          'Upload your .docx Master CV template first in Add & Sources.',
        );
      }

      const originalBuffer = Buffer.from(
        profile.original_file_base64,
        'base64',
      );
      const diffs = job.tailoring_diffs_json as TailoringDiffMap | null;
      if (diffs && Object.keys(diffs).length > 0) {
        const { docxBuffer } = await patchDocxWithReplacements(
          originalBuffer,
          diffs,
        );
        return docxBuffer;
      }

      return patchDocxWithTailoredCv(
        originalBuffer,
        template,
        job.tailored_cv_json as TailoredCV,
      );
    };

    if (format === 'docx') {
      const patchedDocx = await resolvePatchedDocx();

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

    // PDF path: serve cached validated PDF, or convert exact patched .docx -> .pdf on-the-fly
    let pdfBuffer: Buffer | null = null;
    if (job.tailored_pdf_base64) {
      const candidatePdf = Buffer.from(job.tailored_pdf_base64, 'base64');
      const check = await validatePdfBinary(candidatePdf);
      if (check.valid && check.pageCount === 1) {
        pdfBuffer = candidatePdf;
      }
    }

    if (!pdfBuffer) {
      const patchedDocx = await resolvePatchedDocx();
      const convertedPdf = await convertDocxToPdf(
        patchedDocx,
        `Eden_Hadad_CV_${safeCompany}.docx`,
      );
      const check = await validatePdfBinary(convertedPdf);
      if (!check.valid) {
        if (check.pageCount !== 1) {
          await supabase
            .from('jobs')
            .update({
              status: 'failed_validation',
              validation_error: 'Exceeded 1 page',
              tailored_docx_base64: null,
              tailored_pdf_base64: null,
            })
            .eq('id', job.id);
        }
        return NextResponse.json(
          { error: check.errors[0] || 'Exceeded 1 page' },
          { status: 422 },
        );
      }

      pdfBuffer = convertedPdf;
      await supabase
        .from('jobs')
        .update({
          tailored_docx_base64: patchedDocx.toString('base64'),
          tailored_pdf_base64: pdfBuffer.toString('base64'),
          validation_error: null,
        })
        .eq('id', job.id);
    }

    const filename = `Eden_Hadad_CV_${safeCompany}.pdf`;
    // Inline when explicitly requested (?inline=1) or when ?format=pdf is omitted (legacy preview URL)
    const isInline =
      inlineParam === '1' ||
      (format !== 'pdf' && downloadParam !== '1');
    const disposition = isInline ? 'inline' : 'attachment';

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
    if (error instanceof PdfConverterNotConfiguredError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    const message =
      error instanceof CvValidationError || error instanceof Error
        ? error.message
        : 'Failed to generate CV file.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
