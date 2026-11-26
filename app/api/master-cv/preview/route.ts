import { NextResponse } from 'next/server';
import { isAuthenticated } from '@/lib/auth';
import { CvValidationError, validateAndRenderCv } from '@/lib/cv-validator';
import { getActiveMasterCv } from '@/lib/master-cv-store';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    if (!(await isAuthenticated())) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const format = searchParams.get('format');
    const { template, profile } = await getActiveMasterCv();

    if (format === 'docx') {
      if (!profile?.original_file_base64) {
        return NextResponse.json(
          { error: 'No original .docx template is uploaded yet.' },
          { status: 400 },
        );
      }
      const docxBuffer = Buffer.from(profile.original_file_base64, 'base64');
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

    const { pdfBuffer } = await validateAndRenderCv(template, undefined, {
      preserveUploadedShape: true,
    });

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
    const message =
      error instanceof CvValidationError
        ? error.message
        : 'Failed to render Master CV preview.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
