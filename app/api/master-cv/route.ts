import { NextResponse } from 'next/server';
import { isAuthenticated } from '@/lib/auth';
import { CvValidationError, validateAndRenderCv } from '@/lib/cv-validator';
import { parseUploadedCvToTemplate } from '@/lib/gemini';
import {
  deleteMasterCvProfile,
  getActiveMasterCv,
  getDefaultMasterCvTemplate,
  saveMasterCvProfile,
} from '@/lib/master-cv-store';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

export async function GET() {
  try {
    if (!(await isAuthenticated())) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { template, profile } = await getActiveMasterCv();
    return NextResponse.json({
      hasCustomCv: Boolean(profile),
      profile,
      template,
    });
  } catch (error) {
    console.error('[api/master-cv GET] Error:', error);
    return NextResponse.json(
      { error: 'Failed to load Master CV.' },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    if (!(await isAuthenticated())) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const formData = await request.formData();
    const entry = formData.get('file');

    if (!(entry instanceof File)) {
      return NextResponse.json(
        { error: 'Please select a .pdf, .docx, or .txt CV file.' },
        { status: 400 },
      );
    }

    if (entry.size === 0 || entry.size > MAX_UPLOAD_BYTES) {
      return NextResponse.json(
        { error: 'CV file must be non-empty and under 5 MB.' },
        { status: 400 },
      );
    }

    const buffer = Buffer.from(await entry.arrayBuffer());
    const parsed = await parseUploadedCvToTemplate({
      filename: entry.name || 'resume.pdf',
      mimeType: entry.type || '',
      buffer,
    });

    const rendered = await validateAndRenderCv(parsed.template, undefined, {
      preserveUploadedShape: true,
    });

    const profile = await saveMasterCvProfile({
      filename: entry.name || 'resume.pdf',
      rawText: parsed.rawText,
      structured: rendered.cv,
    });

    return NextResponse.json(
      {
        hasCustomCv: true,
        profile,
        template: profile.structured_json,
        pageCount: rendered.pageCount,
        byteLength: rendered.byteLength,
        density: rendered.density,
      },
      { status: 201 },
    );
  } catch (error) {
    console.error('[api/master-cv POST] Error:', error);
    const message =
      error instanceof CvValidationError
        ? error.message
        : error instanceof Error
          ? error.message
          : 'Failed to process uploaded CV.';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function DELETE() {
  try {
    if (!(await isAuthenticated())) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    await deleteMasterCvProfile();
    return NextResponse.json({
      ok: true,
      hasCustomCv: false,
      profile: null,
      template: getDefaultMasterCvTemplate(),
    });
  } catch (error) {
    console.error('[api/master-cv DELETE] Error:', error);
    return NextResponse.json(
      { error: 'Failed to reset Master CV.' },
      { status: 500 },
    );
  }
}
