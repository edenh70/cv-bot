import { NextResponse } from 'next/server';
import { isAuthenticated } from '@/lib/auth';
import { CvValidationError, validatePdfBinary } from '@/lib/cv-validator';
import {
  convertDocxToPdf,
  PdfConverterNotConfiguredError,
} from '@/lib/docx-to-pdf';
import { getActiveMasterCv } from '@/lib/master-cv-store';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: Request) {
  try {
    if (!(await isAuthenticated())) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const format = searchParams.get('format');
    const { profile } = await getActiveMasterCv();

    if (!profile?.original_file_base64) {
      return NextResponse.json(
        { error: 'No original .docx template is uploaded yet.' },
        { status: 400 },
      );
    }

    const docxBuffer = Buffer.from(profile.original_file_base64, 'base64');

    if (format === 'docx') {
      return new Response(new Uint8Array(docxBuffer), {
        status: 200,
        headers: {
          'Content-Type':
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'Content-Disposition':
            'attachment; filename="Eden_Hadad_Master_CV.docx"',
          'Cache-Control': 'private, no-store',
        },
      });
    }

    const pdfBuffer = await convertDocxToPdf(
      docxBuffer,
      profile.filename || 'Eden_Hadad_Master_CV.docx',
    );
    const pdfCheck = await validatePdfBinary(pdfBuffer);
    if (!pdfCheck.valid) {
      throw new CvValidationError(pdfCheck.errors);
    }

    return new Response(new Uint8Array(pdfBuffer), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'inline; filename="Eden_Hadad_Master_CV.pdf"',
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (error) {
    console.error('[api/master-cv/preview GET] Error:', error);
    if (error instanceof PdfConverterNotConfiguredError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    const message =
      error instanceof CvValidationError || error instanceof Error
        ? error.message
        : 'Failed to generate Master CV preview.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
