import { NextResponse } from 'next/server';
import { isAuthenticated } from '@/lib/auth';
import { CvValidationError, validateAndRenderCv } from '@/lib/cv-validator';
import { analyzeAndTailorJob } from '@/lib/gemini';
import { scrapeUrlWithJina } from '@/lib/jina';
import { getActiveMasterCv } from '@/lib/master-cv-store';
import { getSupabaseAdmin } from '@/lib/supabase';

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
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (fetchError) {
      return NextResponse.json({ error: fetchError.message }, { status: 500 });
    }
    if (!existing) {
      return NextResponse.json({ error: 'Job not found.' }, { status: 404 });
    }

    const [{ template: masterTemplate }, markdown] = await Promise.all([
      getActiveMasterCv(),
      scrapeUrlWithJina(existing.url),
    ]);

    const analysis = await analyzeAndTailorJob(existing.url, markdown, {
      company: existing.company,
      title: existing.title,
      masterTemplate,
    });

    const validated = await validateAndRenderCv(
      analysis.tailored_cv_json,
      {
        match_score: analysis.match_score,
        summary_hebrew: analysis.summary_hebrew,
        changes_made: analysis.changes_made,
      },
      { masterTemplate },
    );

    const { data: updated, error: updateError } = await supabase
      .from('jobs')
      .update({
        match_score: analysis.match_score,
        summary_hebrew: analysis.summary_hebrew,
        changes_made: analysis.changes_made,
        tailored_cv_json: validated.cv,
      })
      .eq('id', id)
      .select('*')
      .single();

    if (updateError) {
      return NextResponse.json({ error: updateError.message }, { status: 500 });
    }

    return NextResponse.json({ job: updated });
  } catch (error) {
    console.error('[api/jobs/[id]/retailor POST] Error:', error);
    const message =
      error instanceof CvValidationError
        ? error.message
        : error instanceof Error
          ? error.message
          : 'Failed to re-tailor CV.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
