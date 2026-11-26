import { NextResponse } from 'next/server';
import { isAuthenticated } from '@/lib/auth';
import { CvValidationError, validateAndRenderCv } from '@/lib/cv-validator';
import { getActiveMasterCv } from '@/lib/master-cv-store';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    if (!(await isAuthenticated())) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { template } = await getActiveMasterCv();
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
