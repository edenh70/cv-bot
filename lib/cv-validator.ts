import { renderCvPdfBuffer } from './cv-pdf';
import { CV_LIMITS, sanitizeTailoredCV, truncateClean } from './cv-schema';
import { MASTER_CV } from './master-cv';
import type { TailoredCV } from './types';

export const CV_PDF_BOUNDS = {
  MIN_BYTES: 2_500,
  MAX_BYTES: 2 * 1024 * 1024,
  REQUIRED_PAGES: 1,
} as const;

export const LEAKAGE_PATTERN =
  /\[INSERT|TODO\b|FIXME\b|\bTBD\b|Lorem ipsum|As an AI|Here is your|```|\{\{|\}\}|\bundefined\b|\bNaN\b/i;

const HEBREW_CHAR_PATTERN = /[\u0590-\u05FF]/;

export class CvValidationError extends Error {
  readonly reasons: string[];

  constructor(reasons: string[]) {
    super(`CV validation failed: ${reasons.join('; ')}`);
    this.name = 'CvValidationError';
    this.reasons = reasons;
  }
}

export interface PdfBinaryValidationResult {
  valid: boolean;
  byteLength: number;
  pageCount: number;
  errors: string[];
}

export interface CvContentValidationResult {
  valid: boolean;
  errors: string[];
}

export interface ValidatedCvMetadata {
  match_score?: number;
  summary_hebrew?: string;
  changes_made?: string;
}

export function countPdfPages(buffer: Buffer): number {
  const pdfLatin1 = buffer.toString('latin1');
  const matches = pdfLatin1.match(/\/Type\s*\/Page\b(?!s)/g);
  return matches ? matches.length : 0;
}

export function validatePdfBinary(buffer: Buffer): PdfBinaryValidationResult {
  const errors: string[] = [];
  const byteLength = buffer.length;

  if (byteLength === 0) {
    errors.push('PDF buffer is empty.');
    return { valid: false, byteLength, pageCount: 0, errors };
  }

  const pdfLatin1 = buffer.toString('latin1');
  if (!pdfLatin1.startsWith('%PDF-')) {
    errors.push('PDF buffer does not start with valid %PDF- magic header.');
  }
  if (!pdfLatin1.includes('%%EOF')) {
    errors.push('PDF buffer is truncated (missing %%EOF trailer).');
  }

  if (byteLength < CV_PDF_BOUNDS.MIN_BYTES) {
    errors.push(
      `PDF size (${byteLength} bytes) is below minimum threshold (${CV_PDF_BOUNDS.MIN_BYTES} bytes).`,
    );
  }
  if (byteLength > CV_PDF_BOUNDS.MAX_BYTES) {
    errors.push(
      `PDF size (${byteLength} bytes) exceeds maximum threshold (${CV_PDF_BOUNDS.MAX_BYTES} bytes).`,
    );
  }

  const pageCount = countPdfPages(buffer);
  if (pageCount !== CV_PDF_BOUNDS.REQUIRED_PAGES) {
    errors.push(
      `PDF page count must be strictly ${CV_PDF_BOUNDS.REQUIRED_PAGES}, got ${pageCount}.`,
    );
  }

  return {
    valid: errors.length === 0,
    byteLength,
    pageCount,
    errors,
  };
}

export function validateTailoredCvContent(
  cv: TailoredCV,
  meta?: ValidatedCvMetadata,
): CvContentValidationResult {
  const errors: string[] = [];

  if (!cv || typeof cv !== 'object') {
    return { valid: false, errors: ['tailored_cv_json is missing or invalid.'] };
  }

  const summary = (cv.summary ?? '').trim();
  if (summary.length < 40 || summary.length > CV_LIMITS.SUMMARY_MAX) {
    errors.push(
      `Summary length (${summary.length}) must be between 40 and ${CV_LIMITS.SUMMARY_MAX} chars.`,
    );
  }

  if (!Array.isArray(cv.experience) || cv.experience.length !== CV_LIMITS.EXPERIENCE_COUNT) {
    errors.push(`Experience must contain exactly ${CV_LIMITS.EXPERIENCE_COUNT} roles.`);
  } else {
    cv.experience.forEach((role, idx) => {
      const masterRole = MASTER_CV.experience[idx];
      if (!role.role || role.role.trim().length === 0 || role.role.length > CV_LIMITS.ROLE_MAX) {
        errors.push(`Experience[${idx}].role is invalid or exceeds ${CV_LIMITS.ROLE_MAX} chars.`);
      }
      if (role.company !== masterRole.company) {
        errors.push(
          `Experience[${idx}].company ("${role.company}") does not match Master CV ("${masterRole.company}").`,
        );
      }
      if (role.period !== masterRole.period) {
        errors.push(
          `Experience[${idx}].period ("${role.period}") does not match Master CV ("${masterRole.period}").`,
        );
      }
      if (!Array.isArray(role.bullets) || role.bullets.length !== CV_LIMITS.BULLETS_PER_ROLE) {
        errors.push(
          `Experience[${idx}] must contain exactly ${CV_LIMITS.BULLETS_PER_ROLE} bullets.`,
        );
      } else {
        role.bullets.forEach((b, bIdx) => {
          const trimmed = (b ?? '').trim();
          if (trimmed.length < 20 || trimmed.length > CV_LIMITS.BULLET_MAX) {
            errors.push(
              `Experience[${idx}].bullets[${bIdx}] length (${trimmed.length}) must be 20–${CV_LIMITS.BULLET_MAX} chars.`,
            );
          }
        });
      }
    });
  }

  if (!Array.isArray(cv.toolbox) || cv.toolbox.length !== CV_LIMITS.TOOLBOX_COUNT) {
    errors.push(`Toolbox must contain exactly ${CV_LIMITS.TOOLBOX_COUNT} categories.`);
  } else {
    cv.toolbox.forEach((group, idx) => {
      const category = (group.category ?? '').trim();
      const items = (group.items ?? '').trim();
      if (!category || !items) {
        errors.push(`Toolbox[${idx}] category and items must be non-empty.`);
      } else if (category.length + 2 + items.length > CV_LIMITS.TOOLBOX_LINE_MAX) {
        errors.push(
          `Toolbox[${idx}] combined line exceeds ${CV_LIMITS.TOOLBOX_LINE_MAX} chars.`,
        );
      }
    });
  }

  if (
    !Array.isArray(cv.education) ||
    cv.education.length === 0 ||
    cv.education.length > CV_LIMITS.EDUCATION_MAX_LINES
  ) {
    errors.push(`Education must contain 1–${CV_LIMITS.EDUCATION_MAX_LINES} lines.`);
  } else {
    const joinedEdu = cv.education.join(' ');
    if (!/Ben-Gurion|Industrial Engineering/i.test(joinedEdu)) {
      errors.push('Education must reference authentic Ben-Gurion / Industrial Engineering degree.');
    }
  }

  const allTextFields: string[] = [
    cv.summary ?? '',
    ...(cv.experience ?? []).flatMap((e) => [e.role ?? '', e.company ?? '', ...(e.bullets ?? [])]),
    ...(cv.toolbox ?? []).flatMap((t) => [t.category ?? '', t.items ?? '']),
    ...(cv.education ?? []),
  ];

  for (const field of allTextFields) {
    const match = field.match(LEAKAGE_PATTERN);
    if (match) {
      errors.push(`Disallowed placeholder or LLM leakage detected: "${match[0]}".`);
      break;
    }
  }

  if (meta) {
    if (
      meta.match_score !== undefined &&
      (!Number.isInteger(meta.match_score) || meta.match_score < 1 || meta.match_score > 10)
    ) {
      errors.push(`match_score (${meta.match_score}) must be an integer between 1 and 10.`);
    }
    if (meta.summary_hebrew !== undefined) {
      const hebrewTrimmed = meta.summary_hebrew.trim();
      if (hebrewTrimmed.length < 15 || !HEBREW_CHAR_PATTERN.test(hebrewTrimmed)) {
        errors.push('summary_hebrew must contain a valid Hebrew role summary (>= 15 chars).');
      }
    }
    if (meta.changes_made !== undefined && meta.changes_made.trim().length < 10) {
      errors.push('changes_made must describe the CV tailoring changes.');
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

function trimCvSlightly(cv: TailoredCV, factor: number): TailoredCV {
  return {
    ...cv,
    summary: truncateClean(cv.summary, Math.max(80, Math.floor(cv.summary.length * factor))),
    experience: cv.experience.map((exp) => ({
      ...exp,
      bullets: exp.bullets.map((b) =>
        truncateClean(b, Math.max(45, Math.floor(b.length * factor))),
      ) as [string, string, string],
    })) as TailoredCV['experience'],
  };
}

export async function validateAndRenderCv(
  rawCv: TailoredCV,
  meta?: ValidatedCvMetadata,
): Promise<{
  cv: TailoredCV;
  pdfBuffer: Buffer;
  byteLength: number;
  pageCount: number;
}> {
  let currentCv = sanitizeTailoredCV(rawCv);
  const contentCheck = validateTailoredCvContent(currentCv, meta);
  if (!contentCheck.valid) {
    throw new CvValidationError(contentCheck.errors);
  }

  let pdfBuffer = await renderCvPdfBuffer(currentCv);
  let binaryCheck = validatePdfBinary(pdfBuffer);

  // Auto-trim and re-render up to 3 attempts if PDF somehow overflows beyond 1 page
  for (let attempt = 0; attempt < 3 && binaryCheck.pageCount > CV_PDF_BOUNDS.REQUIRED_PAGES; attempt++) {
    currentCv = trimCvSlightly(currentCv, 0.88);
    pdfBuffer = await renderCvPdfBuffer(currentCv);
    binaryCheck = validatePdfBinary(pdfBuffer);
  }

  if (!binaryCheck.valid) {
    throw new CvValidationError(binaryCheck.errors);
  }

  return {
    cv: currentCv,
    pdfBuffer,
    byteLength: binaryCheck.byteLength,
    pageCount: binaryCheck.pageCount,
  };
}
