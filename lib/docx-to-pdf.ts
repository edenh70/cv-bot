export type PdfProviderName = 'convertapi' | 'gotenberg' | 'cloudconvert';

export type DocxToPdfConverter = (
  docxBuffer: Buffer,
  filename?: string,
) => Promise<Buffer>;

export class PdfConverterNotConfiguredError extends Error {
  constructor(
    message = 'No pixel-exact DOCX-to-PDF converter is configured on the server. Set CONVERTAPI_SECRET (recommended), CLOUDCONVERT_API_KEY, or GOTENBERG_URL in Vercel environment variables.',
  ) {
    super(message);
    this.name = 'PdfConverterNotConfiguredError';
  }
}

export function getConfiguredPdfProvider(): PdfProviderName | null {
  if (process.env.CONVERTAPI_SECRET?.trim()) return 'convertapi';
  if (process.env.GOTENBERG_URL?.trim()) return 'gotenberg';
  if (process.env.CLOUDCONVERT_API_KEY?.trim()) return 'cloudconvert';
  return null;
}

export function isPdfConverterConfigured(): boolean {
  return getConfiguredPdfProvider() !== null;
}

function assertPdfMagicHeader(buffer: Buffer, provider: string): Buffer {
  if (buffer.length < 100 || !buffer.subarray(0, 5).toString('latin1').startsWith('%PDF-')) {
    throw new Error(`${provider} returned invalid PDF bytes (missing %PDF- header).`);
  }
  return buffer;
}

async function convertViaConvertApi(
  docxBuffer: Buffer,
  filename: string,
): Promise<Buffer> {
  const secret = process.env.CONVERTAPI_SECRET!.trim();
  const res = await fetch('https://v2.convertapi.com/convert/docx/to/pdf', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      Parameters: [
        {
          Name: 'File',
          FileValue: {
            Name: filename,
            Data: docxBuffer.toString('base64'),
          },
        },
        {
          Name: 'StoreFile',
          Value: false,
        },
      ],
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(
      `ConvertAPI DOCX-to-PDF failed (${res.status}): ${errText.slice(0, 300)}`,
    );
  }

  const data = (await res.json()) as {
    Files?: Array<{ FileData?: string; Url?: string }>;
  };
  const firstFile = data.Files?.[0];
  if (firstFile?.FileData) {
    return assertPdfMagicHeader(
      Buffer.from(firstFile.FileData, 'base64'),
      'ConvertAPI',
    );
  }
  if (firstFile?.Url) {
    const dlRes = await fetch(firstFile.Url, { signal: AbortSignal.timeout(15_000) });
    if (!dlRes.ok) {
      throw new Error(`ConvertAPI file download failed (${dlRes.status}).`);
    }
    return assertPdfMagicHeader(
      Buffer.from(await dlRes.arrayBuffer()),
      'ConvertAPI',
    );
  }

  throw new Error('ConvertAPI response did not include converted PDF data.');
}

async function convertViaGotenberg(
  docxBuffer: Buffer,
  filename: string,
): Promise<Buffer> {
  const baseUrl = process.env.GOTENBERG_URL!.trim().replace(/\/+$/, '');
  const apiKey = process.env.GOTENBERG_API_KEY?.trim();

  const formData = new FormData();
  formData.append(
    'files',
    new Blob([new Uint8Array(docxBuffer)], {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    }),
    filename,
  );

  const headers: Record<string, string> = {};
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const res = await fetch(`${baseUrl}/forms/libreoffice/convert`, {
    method: 'POST',
    headers,
    body: formData,
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(
      `Gotenberg DOCX-to-PDF failed (${res.status}): ${errText.slice(0, 300)}`,
    );
  }

  return assertPdfMagicHeader(Buffer.from(await res.arrayBuffer()), 'Gotenberg');
}

async function convertViaCloudConvert(
  docxBuffer: Buffer,
  filename: string,
): Promise<Buffer> {
  const apiKey = process.env.CLOUDCONVERT_API_KEY!.trim();
  const res = await fetch('https://sync.api.cloudconvert.com/v2/jobs', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      tasks: {
        'import-docx': {
          operation: 'import/base64',
          file: docxBuffer.toString('base64'),
          filename,
        },
        'convert-pdf': {
          operation: 'convert',
          input: 'import-docx',
          input_format: 'docx',
          output_format: 'pdf',
        },
        'export-pdf': {
          operation: 'export/url',
          input: 'convert-pdf',
        },
      },
    }),
    signal: AbortSignal.timeout(35_000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(
      `CloudConvert DOCX-to-PDF failed (${res.status}): ${errText.slice(0, 300)}`,
    );
  }

  const payload = (await res.json()) as {
    data?: {
      tasks?: Array<{
        name?: string;
        status?: string;
        result?: { files?: Array<{ url?: string }> };
      }>;
    };
  };

  const exportTask = payload.data?.tasks?.find((t) => t.name === 'export-pdf');
  const pdfUrl = exportTask?.result?.files?.[0]?.url;
  if (!pdfUrl) {
    throw new Error('CloudConvert response did not contain an exported PDF URL.');
  }

  const dlRes = await fetch(pdfUrl, { signal: AbortSignal.timeout(15_000) });
  if (!dlRes.ok) {
    throw new Error(`CloudConvert PDF download failed (${dlRes.status}).`);
  }

  return assertPdfMagicHeader(
    Buffer.from(await dlRes.arrayBuffer()),
    'CloudConvert',
  );
}

/**
 * Converts a patched `.docx` buffer directly into a pixel-exact `.pdf` buffer
 * using a Vercel-safe external conversion API (ConvertAPI, Gotenberg, or CloudConvert).
 * Never falls back to rebuilding a PDF layout from scratch.
 */
export async function convertDocxToPdf(
  docxBuffer: Buffer,
  filename = 'resume.docx',
): Promise<Buffer> {
  if (!docxBuffer || docxBuffer.length < 4 || docxBuffer[0] !== 0x50 || docxBuffer[1] !== 0x4b) {
    throw new Error('Cannot convert to PDF: input buffer is not a valid .docx archive.');
  }

  const provider = getConfiguredPdfProvider();
  if (!provider) {
    throw new PdfConverterNotConfiguredError();
  }

  switch (provider) {
    case 'convertapi':
      return convertViaConvertApi(docxBuffer, filename);
    case 'gotenberg':
      return convertViaGotenberg(docxBuffer, filename);
    case 'cloudconvert':
      return convertViaCloudConvert(docxBuffer, filename);
  }
}
