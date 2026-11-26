import { NextResponse } from 'next/server';
import { isAuthenticated } from '@/lib/auth';
import { buildAndValidateTemplateCv, CvValidationError } from '@/lib/cv-validator';
import { extractTailorableBlocksFromDocx } from '@/lib/docx-template';
import { PdfConverterNotConfiguredError } from '@/lib/docx-to-pdf';
import { analyzeAndTailorJob } from '@/lib/gemini';
import { scrapeUrlWithJina } from '@/lib/jina';
import { getActiveMasterCv } from '@/lib/master-cv-store';
import { getSupabaseAdmin, JOB_PUBLIC_COLUMNS } from '@/lib/supabase';

export const maxDuration = 60;

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    if (!(await isAuthenticated())) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await context.params;
    const supabase = getSupabaseAdmin();

    const { data: existing, error: fetchError } = await supabase
      .from('jobs')
      .select(JOB_PUBLIC_COLUMNS)
      .eq('id', id)
      .maybeSingle();

    if (fetchError) {
      return NextResponse.json({ error: fetchError.message }, { status: 500 });
    }
    if (!existing) {
      return NextResponse.json({ error: 'Job not found.' }, { status: 404 });
    }

    const [{ template: masterTemplate, profile }, markdown] = await Promise.all([
      getActiveMasterCv(),
      scrapeUrlWithJina(existing.url),
    ]);

    if (!profile?.original_file_base64) {
      return NextResponse.json(
        {
          error:
            'Upload your .docx Master CV template in Add & Sources first to preserve exact Word formatting.',
        },
        { status: 400 },
      );
    }

    const originalDocxBuffer = Buffer.from(
      profile.original_file_base64,
      'base64',
    );
    const allowedBlocks = await extractTailorableBlocksFromDocx(
      originalDocxBuffer,
      masterTemplate,
    );

    if (allowedBlocks.length === 0) {
      return NextResponse.json(
        {
          error:
            'Could not match tailorable sections in uploaded .docx XML. Please re-upload your .docx CV.',
        },
        { status: 400 },
      );
    }

    const analysis = await analyzeAndTailorJob(existing.url, markdown, {
      company: existing.company,
      title: existing.title,
      masterTemplate,
      tailorableBlocks: allowedBlocks,
    });

    const built = await buildAndValidateTemplateCv({
      originalDocxBuffer,
      masterTemplate,
      allowedBlocks,
      replacements: analysis.replacements,
      meta: {
        match_score: analysis.match_score,
        summary_hebrew: analysis.summary_hebrew,
        changes_made: analysis.changes_made,
      },
    });

    const updatePayload = built.ok
      ? {
          match_score: analysis.match_score,
          summary_hebrew: analysis.summary_hebrew,
          changes_made: analysis.changes_made,
          tailored_cv_json: built.cv,
          tailoring_diffs_json: built.replacements,
          tailored_docx_base64: built.docxBuffer.toString('base64'),
          tailored_pdf_base64: built.pdfBuffer.toString('base64'),
          status:
            existing.status === 'failed_validation'
              ? ('pending_review' as const)
              : existing.status,
          validation_error: null,
        }
      : {
          match_score: analysis.match_score,
          summary_hebrew: analysis.summary_hebrew,
          changes_made: analysis.changes_made,
          tailored_cv_json: built.cv,
          tailoring_diffs_json: built.replacements,
          tailored_docx_base64: null,
          tailored_pdf_base64: null,
          status: 'failed_validation' as const,
          validation_error: built.validationError,
        };

    const { data: updated, error: updateError } = await supabase
      .from('jobs')
      .update(updatePayload)
      .eq('id', id)
      .select(JOB_PUBLIC_COLUMNS)
      .single();

    if (updateError) {
      return NextResponse.json({ error: updateError.message }, { status: 500 });
    }

    return NextResponse.json({ job: updated });
  } catch (error) {
    console.error('[api/jobs/[id]/retailor POST] Error:', error);
    if (error instanceof PdfConverterNotConfiguredError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    const message =
      error instanceof CvValidationError
        ? error.message
        : error instanceof Error
          ? error.message
          : 'Failed to re-tailor CV.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
