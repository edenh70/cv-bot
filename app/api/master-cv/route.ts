import { NextResponse } from 'next/server';
import { isAuthenticated } from '@/lib/auth';
import {
  CvValidationError,
  validatePdfBinary,
  validateTailoredCvContent,
} from '@/lib/cv-validator';
import { validateDocxBinary } from '@/lib/docx-template';
import {
  convertDocxToPdf,
  isPdfConverterConfigured,
} from '@/lib/docx-to-pdf';
import { parseUploadedCvToTemplate } from '@/lib/gemini';
import {
  deleteMasterCvProfile,
  getActiveMasterCv,
  getDefaultMasterCvTemplate,
  saveMasterCvProfile,
  toPublicMasterCvProfile,
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
      hasOriginalDocx: Boolean(profile?.original_file_base64),
      pdfConverterConfigured: isPdfConverterConfigured(),
      profile: toPublicMasterCvProfile(profile),
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
        { error: 'Please select your .docx CV file.' },
        { status: 400 },
      );
    }

    if (entry.size === 0 || entry.size > MAX_UPLOAD_BYTES) {
      return NextResponse.json(
        { error: 'CV file must be non-empty and under 5 MB.' },
        { status: 400 },
      );
    }

    const filename = entry.name || 'resume.docx';
    const mimeType =
      entry.type ||
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    const isDocx =
      filename.toLowerCase().endsWith('.docx') ||
      mimeType ===
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

    if (!isDocx) {
      return NextResponse.json(
        {
          error:
            'Please upload a Word (.docx) file so the bot can preserve 100% of your exact layout and typography.',
        },
        { status: 400 },
      );
    }

    const buffer = Buffer.from(await entry.arrayBuffer());
    const docxCheck = await validateDocxBinary(buffer);
    if (!docxCheck.valid) {
      return NextResponse.json(
        { error: docxCheck.errors.join(' ') },
        { status: 400 },
      );
    }

    const parsed = await parseUploadedCvToTemplate({
      filename,
      mimeType,
      buffer,
    });

    const contentCheck = validateTailoredCvContent(parsed.template);
    if (!contentCheck.valid) {
      throw new CvValidationError(contentCheck.errors);
    }

    let pageCount: number | null = null;
    let pdfVerified = false;
    if (isPdfConverterConfigured()) {
      const pdfBuf = await convertDocxToPdf(buffer, filename);
      const pdfCheck = await validatePdfBinary(pdfBuf);
      if (!pdfCheck.valid) {
        throw new CvValidationError(pdfCheck.errors);
      }
      pageCount = pdfCheck.pageCount;
      pdfVerified = true;
    }

    const profile = await saveMasterCvProfile({
      filename,
      rawText: parsed.rawText,
      structured: parsed.template,
      originalFileBase64: buffer.toString('base64'),
      originalMimeType: mimeType,
    });

    return NextResponse.json(
      {
        hasCustomCv: true,
        hasOriginalDocx: Boolean(profile.original_file_base64),
        pdfVerified,
        pageCount,
        profile: toPublicMasterCvProfile(profile),
        template: profile.structured_json,
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
      hasOriginalDocx: false,
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
